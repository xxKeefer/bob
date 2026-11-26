import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync as writeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { readSessionId, statusline } from "../src/statusline.ts";

const bin = join(import.meta.dirname, "..", "bin", "bob.ts");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bob-sl-"));
}

const NOW = Math.floor(Date.now() / 1000);

function send(dir: string, event: string, id: string, now: number): void {
  handle(dir, JSON.stringify({ hook_event_name: event, session_id: id, cwd: "/w/" + id, message: "m" }), now, {}, () => "");
}

function waiting(dir: string, id: string): void {
  send(dir, "SessionStart", id, NOW);
  send(dir, "Notification", id, NOW);
}

test("no rows prints an empty line", () => {
  assert.equal(statusline(tempDir(), NOW + 5, undefined), "\n");
});

test("one waiting session prints 1 waiting", () => {
  const dir = tempDir();
  waiting(dir, "a");
  send(dir, "SessionStart", "b", NOW);
  assert.equal(statusline(dir, NOW + 5, undefined), "1 waiting\n");
});

test("two waiting sessions print 2 waiting", () => {
  const dir = tempDir();
  waiting(dir, "a");
  waiting(dir, "b");
  assert.equal(statusline(dir, NOW + 5, undefined), "2 waiting\n");
});

test("the calling session is not counted", () => {
  const dir = tempDir();
  waiting(dir, "a");
  waiting(dir, "b");
  assert.equal(statusline(dir, NOW + 5, "a"), "1 waiting\n");
  assert.equal(statusline(dir, NOW + 5, "zzz"), "2 waiting\n");
});

test("only the calling session waiting prints an empty line", () => {
  const dir = tempDir();
  waiting(dir, "a");
  assert.equal(statusline(dir, NOW + 5, "a"), "\n");
});

test("readSessionId reads the id once the JSON is whole, with no end of input", async () => {
  const input = new PassThrough();
  const pending = readSessionId(input, 5000);
  input.write('{"session_id":"abc",');
  input.write('"cwd":"/x"}');
  assert.equal(await pending, "abc");
});

test("readSessionId gives up at the timeout when input never ends", async () => {
  const input = new PassThrough();
  const start = Date.now();
  assert.equal(await readSessionId(input, 50), undefined);
  assert.ok(Date.now() - start < 1000);
});

test("readSessionId gives undefined for bad JSON, empty input, and a missing id", async () => {
  for (const text of ["{nope", "", "[]", '{"a":1}']) {
    const input = new PassThrough();
    input.end(text);
    assert.equal(await readSessionId(input, 1000), undefined);
  }
});

test("the command prints the count, skips the caller, and writes nothing", () => {
  const dir = tempDir();
  waiting(dir, "a");
  waiting(dir, "b");
  const before = readdirSync(dir);
  const env = { ...process.env, BOB_STATE_DIR: dir };
  const all = spawnSync("node", [bin, "statusline"], { input: "{}", env, encoding: "utf8" });
  assert.equal(all.status, 0);
  assert.equal(all.stdout, "2 waiting\n");
  const self = spawnSync("node", [bin, "statusline"], { input: '{"session_id":"a"}', env, encoding: "utf8" });
  assert.equal(self.stdout, "1 waiting\n");
  assert.deepEqual(readdirSync(dir), before);
});

test("the command exits fast when stdin never ends", async () => {
  const dir = tempDir();
  waiting(dir, "a");
  const start = Date.now();

  const out = await new Promise<string>((resolve) => {
    const child = spawn("node", [bin, "statusline"], { env: { ...process.env, BOB_STATE_DIR: dir } });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("close", () => resolve(text));
  });

  assert.equal(out, "1 waiting\n");
  assert.ok(Date.now() - start < 2000);
});

test("the command loads statusline.ts but not the viewer, installer, or demo", () => {
  const dir = tempDir();
  const preload = join(dir, "trace.mjs");
  const log = join(dir, "loaded.txt");

  const body =
    'import { registerHooks } from "node:module";\nimport { appendFileSync } from "node:fs";\n' +
    "registerHooks({ resolve(specifier, context, next) {\n" +
    "  const result = next(specifier, context);\n" +
    "  appendFileSync(" + JSON.stringify(log) + ', result.url + "\\n");\n' +
    "  return result;\n} });\n";

  writeFile(preload, body);
  spawnSync("node", ["--import", preload, bin, "statusline"], { input: "{}", env: { ...process.env, BOB_STATE_DIR: dir } });
  const loaded = readFileSync(log, "utf8").split("\n");
  assert.ok(loaded.some((url) => url.endsWith("/src/statusline.ts")));

  for (const name of ["view", "install", "demo", "keys", "select", "prune"]) {
    assert.ok(!loaded.some((url) => url.endsWith("/src/" + name + ".ts")), name);
  }
});

