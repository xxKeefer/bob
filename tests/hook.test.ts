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

function sendWith(dir: string, event: string, id: string, now: number, env: Record<string, string>): void {
  const raw = JSON.stringify({ hook_event_name: event, session_id: id, cwd: "/w/" + id });
  handle(dir, raw, now, env, () => "");
}

test("zellij env stores the multiplexer, the session name, and the pane", () => {
  const dir = tempDir();
  sendWith(dir, "SessionStart", "a", 100, { ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "work" });
  const [row] = rows(dir);
  assert.equal(row?.multiplexer, "zellij");
  assert.equal(row?.mux_session, "work");
  assert.equal(row?.pane_id, "3");
});

test("zellij values win when tmux and zellij are both set", () => {
  const dir = tempDir();
  sendWith(dir, "SessionStart", "a", 100, {
    TMUX_PANE: "%1",
    ZELLIJ_PANE_ID: "3",
    ZELLIJ_SESSION_NAME: "work",
  });
  const [row] = rows(dir);
  assert.equal(row?.multiplexer, "zellij");
  assert.equal(row?.mux_session, "work");
  assert.equal(row?.pane_id, "3");
});

test("no multiplexer stores three empty values", () => {
  const dir = tempDir();
  sendWith(dir, "SessionStart", "a", 100, {});
  const [row] = rows(dir);
  assert.equal(row?.multiplexer, "");
  assert.equal(row?.mux_session, "");
  assert.equal(row?.pane_id, "");
});

test("a database from before the multiplexer columns gains them and keeps old rows", () => {
  const dir = tempDir();
  const db = new DatabaseSync(join(dir, "bob.db"));
  db.exec(
    "create table sessions (session_id text primary key, cwd text not null, status text not null, since integer not null, updated integer not null, reason text not null, transcript_path text not null default '')",
  );
  db.exec("insert into sessions values ('old', '/w/old', 'idle', 1, 1, '', '')");
  db.close();
  sendWith(dir, "SessionStart", "new", 50, { ZELLIJ_PANE_ID: "7", ZELLIJ_SESSION_NAME: "s" });
  const found = rows(dir);
  assert.equal(found.length, 2);
  assert.equal(found[0]?.session_id, "new");
  assert.equal(found[0]?.pane_id, "7");
  assert.equal(found[1]?.session_id, "old");
  assert.equal(found[1]?.multiplexer, "");
});

test("a later event with an empty environment keeps the stored multiplexer values", () => {
  const dir = tempDir();
  sendWith(dir, "SessionStart", "a", 100, { ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "work" });
  sendWith(dir, "Stop", "a", 110, {});
  sendWith(dir, "UserPromptSubmit", "a", 120, {});
  const [row] = rows(dir);
  assert.equal(row?.multiplexer, "zellij");
  assert.equal(row?.mux_session, "work");
  assert.equal(row?.pane_id, "3");
});

function sendTmux(dir: string, lookup: (pane: string) => string): void {
  const raw = JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/a" });
  handle(dir, raw, 100, { TMUX_PANE: "%4" }, lookup);
}

test("tmux env and a lookup store the multiplexer, the looked-up name, and the pane", () => {
  const dir = tempDir();
  const asked: string[] = [];
  sendTmux(dir, (pane) => {
    asked.push(pane);

    return "main";
  });
  const [row] = rows(dir);
  assert.deepEqual(asked, ["%4"]);
  assert.equal(row?.multiplexer, "tmux");
  assert.equal(row?.mux_session, "main");
  assert.equal(row?.pane_id, "%4");
});

test("a lookup that throws keeps the pane and stores an empty name", () => {
  const dir = tempDir();
  sendTmux(dir, () => {
    throw new Error("no tmux");
  });
  const [row] = rows(dir);
  assert.equal(row?.multiplexer, "tmux");
  assert.equal(row?.mux_session, "");
  assert.equal(row?.pane_id, "%4");
});
