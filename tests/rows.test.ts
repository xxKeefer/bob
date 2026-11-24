import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { loadRows, STALE_SECONDS } from "../src/rows.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bob-rows-"));
}

function send(dir: string, event: string, id: string, now: number, extra = {}): void {
  handle(dir, JSON.stringify({ hook_event_name: event, session_id: id, cwd: "/w/" + id, ...extra }), now);
}

test("the stale limit is 3600 seconds", () => {
  assert.equal(STALE_SECONDS, 3600);
});

test("waiting rows come first with the longest wait on top, then busy, then idle", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "idle1", 100);
  send(dir, "UserPromptSubmit", "busy1", 110);
  send(dir, "SessionStart", "wait-new", 300);
  send(dir, "Notification", "wait-new", 300, { message: "new" });
  send(dir, "SessionStart", "wait-old", 200);
  send(dir, "Notification", "wait-old", 200, { message: "old" });
  const ids = loadRows(dir, 400).map((row) => row.sessionId);
  assert.deepEqual(ids, ["wait-old", "wait-new", "busy1", "idle1"]);
});

test("a row carries status, since, cwd, and reason", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "Notification", "a", 100, { message: "Allow Bash?" });
  const [row] = loadRows(dir, 150);
  assert.equal(row?.sessionId, "a");
  assert.equal(row?.cwd, "/w/a");
  assert.equal(row?.status, "waiting");
  assert.equal(row?.since, 100);
  assert.equal(row?.updated, 100);
  assert.equal(row?.reason, "Allow Bash?");
});

test("a row carries the tokens and the model from its transcript, and none when it has no transcript", () => {
  const dir = tempDir();
  const file = join(dir, "t.jsonl");
  const usage = { input_tokens: 2, cache_creation_input_tokens: 8, cache_read_input_tokens: 90 };
  writeFileSync(file, JSON.stringify({ message: { model: "claude-opus-5-5", usage } }) + "\n");
  send(dir, "SessionStart", "with", 100, { transcript_path: file });
  send(dir, "SessionStart", "without", 101);
  const found = loadRows(dir, 150);
  assert.deepEqual(found.find((row) => row.sessionId === "with")?.context, { tokens: 100, model: "claude-opus-5-5" });
  assert.equal(found.find((row) => row.sessionId === "without")?.context, undefined);
});

test("a database from before the transcript column loads with no context and stays unchanged", () => {
  const dir = tempDir();
  const db = new DatabaseSync(join(dir, "bob.db"));
  db.exec(
    "create table sessions (session_id text primary key, cwd text not null, status text not null, since integer not null, updated integer not null, reason text not null)",
  );
  db.exec("insert into sessions values ('old', '/w/old', 'idle', 1, 1, '')");
  db.close();
  const errors: Error[] = [];
  const [row] = loadRows(dir, 5, (error) => errors.push(error));
  assert.equal(row?.sessionId, "old");
  assert.equal(row?.context, undefined);
  assert.deepEqual(errors, []);
});

test("an age of the limit minus 1 is fresh and an age of the limit is stale", () => {
  const dir = tempDir();
  send(dir, "UserPromptSubmit", "a", 1000);
  assert.equal(loadRows(dir, 1000 + STALE_SECONDS - 1)[0]?.status, "busy");
  assert.equal(loadRows(dir, 1000 + STALE_SECONDS)[0]?.status, "stale");
});

test("a stale row keeps its reason and sorts below idle", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "old", 0);
  send(dir, "Notification", "old", 0, { message: "Allow?" });
  send(dir, "SessionStart", "idle1", 9000);
  const rows = loadRows(dir, 9100);
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ["idle1", "old"],
  );
  assert.equal(rows[1]?.status, "stale");
  assert.equal(rows[1]?.reason, "Allow?");
});

test("two sessions in one folder give two rows", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100, { cwd: "/w/same" });
  send(dir, "SessionStart", "b", 100, { cwd: "/w/same" });
  assert.equal(loadRows(dir, 110).length, 2);
});

test("a missing database gives an empty list and creates nothing", () => {
  const dir = tempDir();
  assert.deepEqual(loadRows(dir, 100), []);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(loadRows(join(dir, "nope"), 100), []);
  assert.equal(existsSync(join(dir, "nope")), false);
});

test("a corrupt database gives an empty list", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "bob.db"), "this is not a database, not at all, no sir".repeat(50));
  assert.deepEqual(loadRows(dir, 100), []);
});

test("an empty database file gives an empty list", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "bob.db"), "");
  assert.deepEqual(loadRows(dir, 100), []);
  assert.deepEqual(readdirSync(dir), ["bob.db"]);
});

test("a corrupt database calls onError and a missing database does not", () => {
  const dir = tempDir();
  const errors: number[] = [];
  loadRows(dir, 100, () => errors.push(1));
  assert.equal(errors.length, 0);
  writeFileSync(join(dir, "bob.db"), "this is not a database, not at all, no sir".repeat(50));
  assert.deepEqual(loadRows(dir, 100, () => errors.push(1)), []);
  assert.equal(errors.length, 1);
});

test("an empty database file does not call onError", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "bob.db"), "");
  const errors: Error[] = [];
  assert.deepEqual(loadRows(dir, 100, (error) => errors.push(error)), []);
  assert.equal(errors.length, 0);
});

test("a database with no sessions table does not call onError", () => {
  const dir = tempDir();
  const db = new DatabaseSync(join(dir, "bob.db"));
  db.exec("create table other (a)");
  db.close();
  const errors: Error[] = [];
  assert.deepEqual(loadRows(dir, 100, (error) => errors.push(error)), []);
  assert.equal(errors.length, 0);
});

test("a corrupt database passes the error to onError", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "bob.db"), "this is not a database, not at all, no sir".repeat(50));
  const errors: Error[] = [];
  loadRows(dir, 100, (error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.message.length);
});
