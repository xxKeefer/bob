import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { devStarter, pickPort, readPorts, readSelected, realIsFree, setPort, writePort, writeSelected } from "../src/dev.ts";
import type { RunResult } from "../src/mux.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "bob-dev-"));

test("pickPort takes the first free port in the range", async () => {
  assert.equal(await pickPort(4100, 4105, new Set(), async (port) => port >= 4102), 4102);
});

test("pickPort skips taken ports", async () => {
  assert.equal(await pickPort(4100, 4105, new Set([4100, 4101]), async () => true), 4102);
});

test("pickPort gives undefined when the range is full", async () => {
  assert.equal(await pickPort(4100, 4101, new Set(), async () => false), undefined);
});

test("realIsFree is false for a port in use and true once released", async () => {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = address instanceof Object && "port" in address ? address.port : 0;
  assert.equal(await realIsFree(port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await realIsFree(port), true);
});

test("setPort adds a PORT line to empty text", () => {
  assert.equal(setPort("", 4100), "PORT=4100\n");
});

test("setPort replaces an existing PORT line and keeps the others", () => {
  assert.equal(setPort("A=1\nPORT=3000\nB=2\n", 4100), "A=1\nPORT=4100\nB=2\n");
});

test("setPort appends after text with no trailing newline", () => {
  assert.equal(setPort("A=1", 4100), "A=1\nPORT=4100\n");
});

test("setPort does not touch a similar key", () => {
  assert.equal(setPort("MYPORT=1\n", 4100), "MYPORT=1\nPORT=4100\n");
});

test("ports round-trip by folder", () => {
  const dir = tmp();
  assert.deepEqual(readPorts(dir), new Map());
  writePort(dir, "/w/a", 4100);
  writePort(dir, "/w/b", 4101);
  writePort(dir, "/w/a", 4102);
  assert.deepEqual(readPorts(dir), new Map([["/w/a", 4102], ["/w/b", 4101]]));
});

test("readPorts drops relative folders and bad ports", () => {
  const dir = tmp();
  writeFileSync(join(dir, "ports.json"), JSON.stringify({ "rel/a": 4100, "/w/a": "x", "/w/b": 4101, "/w/c": 0 }));
  assert.deepEqual(readPorts(dir), new Map([["/w/b", 4101]]));
});

test("readPorts survives bad json", () => {
  const dir = tmp();
  writeFileSync(join(dir, "ports.json"), "{");
  assert.deepEqual(readPorts(dir), new Map());
});

test("selected round-trips and is undefined when empty, relative, or missing", () => {
  const dir = tmp();
  assert.equal(readSelected(dir), undefined);
  writeSelected(dir, "/w/a");
  assert.equal(readSelected(dir), "/w/a");
  writeSelected(dir, "");
  assert.equal(readSelected(dir), undefined);
  writeFileSync(join(dir, "selected"), "rel/a");
  assert.equal(readSelected(dir), undefined);
});

type TestConfig = { devCommand?: string[]; devEnvFile?: string; devPortRange?: number[]; proxyPort?: number };

function setup(config: TestConfig) {
  const state = tmp();
  const cfg = tmp();
  const tree = tmp();
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ repo: "/r/app", ...config }));
  const ran: string[][] = [];
  const run = (argv: string[]): RunResult => (ran.push(argv), { ok: true });

  return { state, tree, ran, run, env: { BOB_CONFIG_DIR: cfg, TMUX: "x" } };
}

test("devStarter is off with no dev command", () => {
  const s = setup({});
  assert.equal(devStarter({ env: s.env, home: "/h", stateDir: s.state, run: s.run, isFree: async () => true }), undefined);
});

test("devStarter is off with no state folder", () => {
  const s = setup({ devCommand: ["npm", "run", "dev"] });
  assert.equal(devStarter({ env: s.env, home: "/h", stateDir: undefined, run: s.run, isFree: async () => true }), undefined);
});

test("devStarter picks a port, writes the env file and record, and opens the pane", async () => {
  const s = setup({ devCommand: ["npm", "run", "dev"] });
  writeFileSync(join(s.tree, ".env.local"), "A=1\nPORT=3000\n");
  writePort(s.state, "/w/other", 4100);
  const start = devStarter({ env: s.env, home: "/h", stateDir: s.state, run: s.run, isFree: async () => true });
  assert.deepEqual(await start?.(s.tree), { ok: true });
  assert.equal(readFileSync(join(s.tree, ".env.local"), "utf8"), "A=1\nPORT=4101\n");
  assert.equal(readPorts(s.state).get(s.tree), 4101);
  assert.deepEqual(s.ran, [["tmux", "new-window", "-d", "-c", s.tree, "env", "PORT=4101", "npm", "run", "dev"]]);
});

test("devStarter reuses the recorded port when it is still free", async () => {
  const s = setup({ devCommand: ["npm", "run", "dev"] });
  writePort(s.state, s.tree, 4150);
  const start = devStarter({ env: s.env, home: "/h", stateDir: s.state, run: s.run, isFree: async () => true });
  await start?.(s.tree);
  assert.equal(readPorts(s.state).get(s.tree), 4150);
});

test("devStarter fails with no free port and runs nothing", async () => {
  const s = setup({ devCommand: ["npm", "run", "dev"] });
  const start = devStarter({ env: s.env, home: "/h", stateDir: s.state, run: s.run, isFree: async () => false });
  const result = await start?.(s.tree);
  assert.equal(result?.ok, false);
  assert.deepEqual(s.ran, []);
});

test("devStarter refuses a relative folder", async () => {
  const s = setup({ devCommand: ["npm", "run", "dev"] });
  const start = devStarter({ env: s.env, home: "/h", stateDir: s.state, run: s.run, isFree: async () => true });
  assert.equal((await start?.("rel"))?.ok, false);
  assert.deepEqual(s.ran, []);
});

