import { request } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { readPorts, readSelected } from "./dev.ts";

const HOST = "127.0.0.1";

function target(stateDir: string): { port: number } | { message: string } {
  const folder = readSelected(stateDir);

  if (folder === undefined) return { message: "no row selected" };

  const port = readPorts(stateDir).get(folder);

  return port === undefined ? { message: "no dev server recorded for the selected row" } : { port };
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(`${message}\n`);
}

export function createProxy(stateDir: string): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const found = target(stateDir);

    if ("message" in found) return refuse(res, 503, found.message);

    const upstream = request({ host: HOST, port: found.port, method: req.method, path: req.url, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });

    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else refuse(res, 502, "dev server is not answering");
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const found = target(stateDir);

    if ("message" in found) {
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${found.message}\n`);

      return;
    }

    const upstream = connect(found.port, HOST, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];

      for (let index = 0; index < req.rawHeaders.length; index += 2) lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);

      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });

  return server;
}

export function listen(stateDir: string, port: number): Promise<Server> {
  const server = createProxy(stateDir);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}
