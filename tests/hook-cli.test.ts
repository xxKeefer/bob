import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const bin = join(import.meta.dirname, "..", "bin", "bob.ts");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bob-cli-"));
}

function run(dir: string, input: string) {
  return spawnSync("node", [bin, "hook"], { input, env: { ...process.env, BOB_STATE_DIR: dir }, encoding: "utf8" });
}

function payload(event: string, id: string): string {
  return JSON.stringify({ hook_event_name: event, session_id: id, cwd: "/w" });
}

function count(dir: string): number {
  const db = new DatabaseSync(join(dir, "bob.db"), { readOnly: true });
  const row = db.prepare("select count(*) as n from sessions").get();
  db.close();

  return Number(row?.n);
}

test("a good event writes the row and exits 0", () => {
  const dir = tempDir();
  const result = run(dir, payload("SessionStart", "a"));
  assert.equal(result.status, 0);
  assert.equal(count(dir), 1);
});

test("the hook stamps rows with the current time in seconds", () => {
  const dir = tempDir();
  const before = Math.floor(Date.now() / 1000);
  run(dir, payload("SessionStart", "a"));
  const db = new DatabaseSync(join(dir, "bob.db"), { readOnly: true });
  const row = db.prepare("select updated from sessions").get();
  db.close();

  assert.ok(Number(row?.updated) >= before);
  assert.ok(Number(row?.updated) <= before + 5);
});

test("bad JSON, empty input, and an unknown event exit 0", () => {
  const dir = tempDir();
  assert.equal(run(dir, "{not json").status, 0);
  assert.equal(run(dir, "").status, 0);
  assert.equal(run(dir, payload("Mystery", "a")).status, 0);
  assert.equal(run(dir, "[]").status, 0);
  assert.equal(run(dir, '{"hook_event_name":"Stop"}').status, 0);
});

test("a state path that is a file exits 0", () => {
  const dir = tempDir();
  const file = join(dir, "blocked");
  writeFileSync(file, "x");
  assert.equal(run(file, payload("SessionStart", "a")).status, 0);
});

test("a missing state folder exits 0", () => {
  const dir = tempDir();
  assert.equal(run(join(dir, "no", "such"), payload("SessionStart", "a")).status, 0);
});

test("a locked database exits 0 and finishes fast", () => {
  const dir = tempDir();
  run(dir, payload("SessionStart", "a"));
  const lock = new DatabaseSync(join(dir, "bob.db"));
  lock.exec("begin exclusive");
  const start = Date.now();
  const result = run(dir, payload("Stop", "a"));
  const took = Date.now() - start;
  lock.exec("rollback");
  lock.close();
  assert.equal(result.status, 0);
  assert.ok(took < 2000, "took " + took);
});

test("the hook finishes in under 0.5 seconds", () => {
  const dir = tempDir();
  run(dir, payload("SessionStart", "warm"));
  const start = Date.now();
  run(dir, payload("Stop", "warm"));
  const took = Date.now() - start;
  assert.ok(took < 500, "took " + took);
});

test("two hook processes at once both write and exit 0", async () => {
  const dir = tempDir();
  run(dir, payload("SessionStart", "seed"));

  const codes = await Promise.all(
    ["a", "b", "c", "d"].map(
      (id) =>
        new Promise<number | null>((resolve) => {
          const child = spawn("node", [bin, "hook"], { env: { ...process.env, BOB_STATE_DIR: dir } });
          child.on("close", resolve);
          child.stdin.end(payload("SessionStart", id));
        }),
    ),
  );

  assert.deepEqual(codes, [0, 0, 0, 0]);
  assert.equal(count(dir), 5);
  assert.deepEqual(readdirSync(dir), ["bob.db"]);
});

function runIn(cwd: string, env: Record<string, string>, input: string) {
  const base = { ...process.env, BOB_STATE_DIR: undefined };

  return spawnSync("node", [bin, "hook"], { cwd, input, env: { ...base, ...env }, encoding: "utf8" });
}

test("an empty HOME with no BOB_STATE_DIR writes nothing and exits 0", () => {
  const work = tempDir();
  const result = runIn(work, { HOME: "" }, payload("SessionStart", "a"));
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(work), []);
});

test("an empty HOME and an empty BOB_STATE_DIR write nothing and exit 0", () => {
  const work = tempDir();
  const result = runIn(work, { HOME: "", BOB_STATE_DIR: "" }, payload("SessionStart", "a"));
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(work), []);
});

test("an empty BOB_STATE_DIR falls back to the state folder under HOME", () => {
  const work = tempDir();
  const home = tempDir();
  const result = runIn(work, { HOME: home, BOB_STATE_DIR: "" }, payload("SessionStart", "a"));
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(work), []);
  assert.equal(count(join(home, ".local", "state", "bob")), 1);
});

test("a relative BOB_STATE_DIR writes nothing and exits 0", () => {
  const work = tempDir();
  const result = runIn(work, { HOME: "", BOB_STATE_DIR: "rel" }, payload("SessionStart", "a"));
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(work), []);
});

function muxRow(dir: string) {
  const db = new DatabaseSync(join(dir, "bob.db"), { readOnly: true });
  const row = db.prepare("select multiplexer, mux_session, pane_id from sessions").get();
  db.close();

  return row;
}

test("outside a multiplexer the row holds three empty values and the hook exits 0", () => {
  const dir = tempDir();
  const env = { ...process.env, BOB_STATE_DIR: dir, TMUX_PANE: undefined, ZELLIJ_PANE_ID: undefined, ZELLIJ_SESSION_NAME: undefined };
  const result = spawnSync("node", [bin, "hook"], { input: payload("SessionStart", "a"), env, encoding: "utf8" });
  assert.equal(result.status, 0);
  const row = muxRow(dir);
  assert.equal(row?.multiplexer, "");
  assert.equal(row?.mux_session, "");
  assert.equal(row?.pane_id, "");
});

function fakeTmux(body: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, "tmux"), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });

  return dir;
}

function runTmux(dir: string, fakeBin: string) {
  const env = {
    ...process.env,
    BOB_STATE_DIR: dir,
    PATH: fakeBin + ":" + process.env.PATH,
    TMUX_PANE: "%2",
    ZELLIJ_PANE_ID: undefined,
    ZELLIJ_SESSION_NAME: undefined,
  };

  return spawnSync("node", [bin, "hook"], { input: payload("SessionStart", "a"), env, encoding: "utf8" });
}

test("a fake tmux gives the session name through the real command", () => {
  const dir = tempDir();
  const fake = fakeTmux('[ "$1 $2 $3 $4" = "display-message -p -t %2" ] && [ "$5" = "#{session_name}" ] && echo work');
  const result = runTmux(dir, fake);
  assert.equal(result.status, 0);
  const row = muxRow(dir);
  assert.equal(row?.multiplexer, "tmux");
  assert.equal(row?.mux_session, "work");
  assert.equal(row?.pane_id, "%2");
});

test("a tmux that hangs still lets the hook store the pane and exit 0", () => {
  const dir = tempDir();
  const start = Date.now();
  const result = runTmux(dir, fakeTmux("exec sleep 5"));
  const took = Date.now() - start;
  assert.equal(result.status, 0);
  assert.ok(took < 2000, "took " + took);
  const row = muxRow(dir);
  assert.equal(row?.mux_session, "");
  assert.equal(row?.pane_id, "%2");
});

test("a tmux that fails with output stores an empty name and the pane and exits 0", () => {
  const dir = tempDir();
  const result = runTmux(dir, fakeTmux("echo boom; exit 1"));
  assert.equal(result.status, 0);
  const row = muxRow(dir);
  assert.equal(row?.mux_session, "");
  assert.equal(row?.pane_id, "%2");
});
