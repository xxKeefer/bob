import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { handle } from "../src/hook.ts";
import { parseAge, prune } from "../src/prune.ts";

const bin = join(import.meta.dirname, "..", "bin", "bob.ts");
const NOW = 1_000_000;
const DAY = 86400;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bob-prune-"));
}

function seed(dir: string): void {
  for (const [id, at] of [["old", NOW - 10 * DAY], ["edge", NOW - 7 * DAY], ["new", NOW - 60]] as const) {
    handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: "/w" }), at);
  }
}

function ids(dir: string): string[] {
  const db = new DatabaseSync(join(dir, "bob.db"), { readOnly: true });
  const found = db.prepare("select session_id from sessions order by session_id").all().map((row) => String(row.session_id));
  db.close();

  return found;
}

function go(dir: string, args: string[], answer: string) {
  let out = "";
  let err = "";

  return prune({
    stateDir: dir,
    now: NOW,
    args,
    input: Readable.from([answer]),
    write: (text) => (out += text),
    writeError: (text) => (err += text),
  }).then((code) => ({ code, out, err }));
}

test("parseAge reads s, m, h, d, and w and rejects the rest", () => {
  assert.equal(parseAge("90s"), 90);
  assert.equal(parseAge("5m"), 300);
  assert.equal(parseAge("2h"), 7200);
  assert.equal(parseAge("7d"), 7 * DAY);
  assert.equal(parseAge("1w"), 7 * DAY);
  assert.equal(parseAge("0d"), undefined);
  assert.equal(parseAge("7"), undefined);
  assert.equal(parseAge("-1d"), undefined);
  assert.equal(parseAge("abc"), undefined);
});

test("y deletes rows older than the default 7 days and keeps the rest", async () => {
  const dir = tempDir();
  seed(dir);
  const result = await go(dir, [], "y\n");
  assert.equal(result.code, 0);
  assert.deepEqual(ids(dir), ["edge", "new"]);
  assert.match(result.out, /1 row/);
});

test("--older-than sets the age", async () => {
  const dir = tempDir();
  seed(dir);
  await go(dir, ["--older-than", "1h"], "y\n");
  assert.deepEqual(ids(dir), ["new"]);
});

test("--older-than=2d works", async () => {
  const dir = tempDir();
  seed(dir);
  await go(dir, ["--older-than=2d"], "y\n");
  assert.deepEqual(ids(dir), ["new"]);
});

test("n, empty, and no input delete nothing", async () => {
  for (const answer of ["n\n", "\n", ""]) {
    const dir = tempDir();
    seed(dir);
    const result = await go(dir, [], answer);
    assert.equal(result.code, 0);
    assert.deepEqual(ids(dir), ["edge", "new", "old"]);
  }
});

test("--yes deletes with no question", async () => {
  const dir = tempDir();
  seed(dir);
  const result = await go(dir, ["--yes"], "");
  assert.equal(result.code, 0);
  assert.deepEqual(ids(dir), ["edge", "new"]);
  assert.ok(!/\[y\/N\]/.test(result.out));
});

test("-y is the short form", async () => {
  const dir = tempDir();
  seed(dir);
  await go(dir, ["-y"], "");
  assert.deepEqual(ids(dir), ["edge", "new"]);
});

test("nothing to prune asks nothing and exits 0", async () => {
  const dir = tempDir();
  seed(dir);
  const result = await go(dir, ["--older-than", "30d"], "");
  assert.equal(result.code, 0);
  assert.deepEqual(ids(dir), ["edge", "new", "old"]);
  assert.match(result.out, /nothing/i);
});

test("a bad age or an unknown flag exits 1 and deletes nothing", async () => {
  const dir = tempDir();
  seed(dir);

  for (const args of [["--older-than", "soon"], ["--older-than"], ["--bogus"]]) {
    const result = await go(dir, [...args, "--yes"], "");
    assert.equal(result.code, 1);
    assert.notEqual(result.err, "");
    assert.deepEqual(ids(dir), ["edge", "new", "old"]);
  }
});

test("a missing database exits 0", async () => {
  const result = await go(join(tempDir(), "none"), ["--yes"], "");
  assert.equal(result.code, 0);
});

test("an undefined state dir exits 1", async () => {
  const result = await prune({
    stateDir: undefined,
    now: NOW,
    args: ["--yes"],
    input: Readable.from([""]),
    write: () => undefined,
    writeError: () => undefined,
  });

  assert.equal(result, 1);
});

test("bob prune --yes through the CLI deletes old rows", () => {
  const dir = tempDir();
  const now = Math.floor(Date.now() / 1000);
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "old", cwd: "/w" }), now - 30 * DAY);
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "new", cwd: "/w" }), now);
  const result = spawnSync("node", [bin, "prune", "--yes"], { env: { ...process.env, BOB_STATE_DIR: dir }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(ids(dir), ["new"]);
});

test("bob prune answered n through the CLI deletes nothing", () => {
  const dir = tempDir();
  const now = Math.floor(Date.now() / 1000);
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "old", cwd: "/w" }), now - 30 * DAY);
  const result = spawnSync("node", [bin, "prune"], { input: "n\n", env: { ...process.env, BOB_STATE_DIR: dir }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(ids(dir), ["old"]);
});

test("plain bob --once writes nothing to the database", () => {
  const dir = tempDir();
  const now = Math.floor(Date.now() / 1000);
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "old", cwd: "/w" }), now - 30 * DAY);
  const before = readFileSync(join(dir, "bob.db"));
  const result = spawnSync("node", [bin, "--once"], { env: { ...process.env, BOB_STATE_DIR: dir }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(readFileSync(join(dir, "bob.db")), before);
  assert.deepEqual(readdirSync(dir), ["bob.db"]);
  assert.deepEqual(ids(dir), ["old"]);
});

test("a state dir that is a file exits 0", () => {
  const dir = tempDir();
  const file = join(dir, "blocked");
  writeFileSync(file, "x");
  const result = spawnSync("node", [bin, "prune", "--yes"], { env: { ...process.env, BOB_STATE_DIR: file }, encoding: "utf8" });
  assert.equal(result.status, 0);
});
