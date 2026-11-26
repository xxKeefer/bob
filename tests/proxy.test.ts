import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writePort, writeSelected } from "../src/dev.ts";
import { createProxy } from "../src/proxy.ts";

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      resolve(address instanceof Object && "port" in address ? address.port : 0);
    }),
  );

const close = (server: Server) => new Promise((resolve) => (server.close(resolve), server.closeAllConnections()));

function get(port: number, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });

    req.on("error", reject);
    req.end();
  });
}

function backend(name: string) {
  return createServer((req, res) => res.end(`${name} ${req.method} ${req.url} ${req.headers["x-test"] ?? ""}`));
}

test("the proxy forwards to the port of the selected row and follows a change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-proxy-"));
  const a = backend("a");
  const b = backend("b");
  const portA = await listen(a);
  const portB = await listen(b);
  writePort(dir, "/w/a", portA);
  writePort(dir, "/w/b", portB);
  const proxy = createProxy(dir);
  const port = await listen(proxy);

  try {
    writeSelected(dir, "/w/a");
    assert.deepEqual(await get(port, "/x?y=1"), { status: 200, body: "a GET /x?y=1 " });
    writeSelected(dir, "/w/b");
    assert.deepEqual(await get(port), { status: 200, body: "b GET / " });
  } finally {
    await Promise.all([close(proxy), close(a), close(b)]);
  }
});

test("the proxy gives 503 when nothing is selected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-proxy-"));
  const proxy = createProxy(dir);
  const port = await listen(proxy);

  try {
    const result = await get(port);
    assert.equal(result.status, 503);
    assert.match(result.body, /no row selected/);
  } finally {
    await close(proxy);
  }
});

test("the proxy gives 503 when the selected row has no port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-proxy-"));
  writeSelected(dir, "/w/a");
  const proxy = createProxy(dir);
  const port = await listen(proxy);

  try {
    const result = await get(port);
    assert.equal(result.status, 503);
    assert.match(result.body, /no dev server/);
  } finally {
    await close(proxy);
  }
});

test("the proxy gives 502 when the dev server is down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-proxy-"));
  const dead = backend("dead");
  const deadPort = await listen(dead);
  await close(dead);
  writePort(dir, "/w/a", deadPort);
  writeSelected(dir, "/w/a");
  const proxy = createProxy(dir);
  const port = await listen(proxy);

  try {
    assert.equal((await get(port)).status, 502);
  } finally {
    await close(proxy);
  }
});

test("the proxy forwards a websocket upgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-proxy-"));
  const target = createServer();
  target.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    socket.on("end", () => socket.end());
  });
  const targetPort = await listen(target);
  writePort(dir, "/w/a", targetPort);
  writeSelected(dir, "/w/a");
  const proxy = createProxy(dir);
  const port = await listen(proxy);

  try {
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;

        if (text.includes("101") && !text.includes("echo:")) socket.write("hi");

        if (text.includes("echo:hi")) {
          socket.destroy();
          resolve(text);
        }
      });
      socket.on("error", reject);
    });

    assert.match(received, /101 Switching Protocols/);
  } finally {
    await Promise.all([close(proxy), close(target)]);
  }
});

test("the proxy gives 503 for an upgrade with no row selected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-proxy-"));
  const proxy = createProxy(dir);
  const port = await listen(proxy);

  try {
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });

    assert.match(text, /503/);
  } finally {
    await close(proxy);
  }
});
