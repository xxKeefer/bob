import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { handle } from "../src/hook.ts";
import { STALE_SECONDS } from "../src/rows.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bob-hook-"));
}

function send(dir: string, event: string, id: string, now: number, extra = {}): void {
  handle(dir, JSON.stringify({ hook_event_name: event, session_id: id, cwd: "/w/" + id, ...extra }), now);
}

function rows(dir: string) {
  const db = new DatabaseSync(join(dir, "bob.db"), { readOnly: true });
  const found = db.prepare("select * from sessions order by session_id").all();
  db.close();

  return found;
}

test("every event stores the transcript path and an event with none keeps the stored one", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100, { transcript_path: "/t/a.jsonl" });
  assert.equal(rows(dir)[0]?.transcript_path, "/t/a.jsonl");
  send(dir, "Stop", "a", 110);
  assert.equal(rows(dir)[0]?.transcript_path, "/t/a.jsonl");
  send(dir, "UserPromptSubmit", "a", 120, { transcript_path: "/t/b.jsonl" });
  assert.equal(rows(dir)[0]?.transcript_path, "/t/b.jsonl");
});

test("a database from before the transcript column gets the column on the next event", () => {
  const dir = tempDir();
  const db = new DatabaseSync(join(dir, "bob.db"));
  db.exec(
    "create table sessions (session_id text primary key, cwd text not null, status text not null, since integer not null, updated integer not null, reason text not null)",
  );
  db.exec("insert into sessions values ('old', '/w/old', 'idle', 1, 1, '')");
  db.close();
  send(dir, "Stop", "old", 50, { transcript_path: "/t/old.jsonl" });
  assert.equal(rows(dir)[0]?.transcript_path, "/t/old.jsonl");
});

test("SessionStart adds an idle row", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  const [row] = rows(dir);
  assert.equal(row?.status, "idle");
  assert.equal(row?.cwd, "/w/a");
  assert.equal(row?.since, 100);
  assert.equal(row?.updated, 100);
  assert.equal(row?.reason, "");
});

test("UserPromptSubmit sets busy and Stop sets idle", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "UserPromptSubmit", "a", 110);
  assert.equal(rows(dir)[0]?.status, "busy");
  send(dir, "Stop", "a", 120);
  assert.equal(rows(dir)[0]?.status, "idle");
});

test("Notification sets waiting with the message, and Stop clears the reason", () => {
  const dir = tempDir();
  send(dir, "UserPromptSubmit", "a", 100);
  send(dir, "Notification", "a", 110, { message: "Claude needs your permission" });
  assert.equal(rows(dir)[0]?.status, "waiting");
  assert.equal(rows(dir)[0]?.reason, "Claude needs your permission");
  send(dir, "Stop", "a", 120);
  assert.equal(rows(dir)[0]?.reason, "");
});

test("Notification with no message gives an empty reason", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 90);
  send(dir, "Notification", "a", 100);
  assert.equal(rows(dir)[0]?.status, "waiting");
  assert.equal(rows(dir)[0]?.reason, "");
});

test("SessionEnd deletes the row and a missing row raises no error", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "SessionEnd", "a", 110);
  assert.equal(rows(dir).length, 0);
  send(dir, "SessionEnd", "a", 120);
  send(dir, "SessionEnd", "never", 120);
  assert.equal(rows(dir).length, 0);
});

test("since stays when the status repeats and resets when it changes", () => {
  const dir = tempDir();
  send(dir, "UserPromptSubmit", "a", 100);
  send(dir, "UserPromptSubmit", "a", 150);
  assert.equal(rows(dir)[0]?.since, 100);
  assert.equal(rows(dir)[0]?.updated, 150);
  send(dir, "Stop", "a", 200);
  assert.equal(rows(dir)[0]?.since, 200);
});

test("sessions are keyed by session_id", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "SessionStart", "b", 100);
  assert.equal(rows(dir).length, 2);
});

test("an unknown event changes nothing", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "PreToolUse", "a", 200);
  assert.equal(rows(dir)[0]?.updated, 100);
});

test("one event leaves only bob.db in the state folder", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "Stop", "a", 110);
  send(dir, "SessionEnd", "a", 120);
  assert.deepEqual(readdirSync(dir), ["bob.db"]);
});

test("Stop after SessionEnd leaves no row", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "SessionEnd", "a", 110);
  send(dir, "Stop", "a", 120);
  assert.equal(rows(dir).length, 0);
});

test("Notification after SessionEnd leaves no row", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 100);
  send(dir, "SessionEnd", "a", 110);
  send(dir, "Notification", "a", 120, { message: "late" });
  assert.equal(rows(dir).length, 0);
});

test("Notification for a session with no SessionStart leaves no row", () => {
  const dir = tempDir();
  send(dir, "Notification", "a", 100, { message: "x" });
  send(dir, "Stop", "b", 100);
  assert.equal(rows(dir).length, 0);
});

test("UserPromptSubmit with no row inserts a busy row", () => {
  const dir = tempDir();
  send(dir, "UserPromptSubmit", "a", 100);
  assert.equal(rows(dir)[0]?.status, "busy");
});

test("since stays when the gap is under the stale limit", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 90);
  send(dir, "Notification", "a", 100);
  send(dir, "Notification", "a", 100 + STALE_SECONDS - 1);
  assert.equal(rows(dir)[0]?.since, 100);
});

test("since resets when the gap reaches the stale limit with the same status", () => {
  const dir = tempDir();
  send(dir, "SessionStart", "a", 90);
  send(dir, "Notification", "a", 100);
  send(dir, "Notification", "a", 100 + STALE_SECONDS);
  assert.equal(rows(dir)[0]?.since, 100 + STALE_SECONDS);
});

test("since resets at the stale limit for a repeated UserPromptSubmit too", () => {
  const dir = tempDir();
  send(dir, "UserPromptSubmit", "a", 100);
  send(dir, "UserPromptSubmit", "a", 100 + STALE_SECONDS - 1);
  assert.equal(rows(dir)[0]?.since, 100);
  send(dir, "UserPromptSubmit", "a", 100 + STALE_SECONDS - 1 + STALE_SECONDS);
  assert.equal(rows(dir)[0]?.since, 100 + STALE_SECONDS - 1 + STALE_SECONDS);
});
