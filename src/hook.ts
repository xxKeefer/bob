import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BUSY_TIMEOUT_MS = 200;

const STATUS_BY_EVENT = new Map([
  ["SessionStart", "idle"],
  ["UserPromptSubmit", "busy"],
  ["Notification", "waiting"],
  ["Stop", "idle"],
]);

const INSERTING_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

export const EVENTS = [...STATUS_BY_EVENT.keys(), "SessionEnd"];

interface Payload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
}

const SCHEMA =
  "create table if not exists sessions (session_id text primary key, cwd text not null, status text not null, since integer not null, updated integer not null, reason text not null)";

const UPSERT =
  "insert into sessions (session_id, cwd, status, since, updated, reason) values (?, ?, ?, ?, ?, ?) " +
  "on conflict(session_id) do update set cwd = excluded.cwd, " +
  "since = case when sessions.status = excluded.status then sessions.since else excluded.since end, " +
  "status = excluded.status, updated = excluded.updated, reason = excluded.reason";

const UPDATE =
  "update sessions set cwd = ?, " +
  "since = case when status = ? then since else ? end, " +
  "status = ?, updated = ?, reason = ? where session_id = ?";

function toStringOrEmpty(value: string | undefined): string {
  return String(value ?? "");
}

export function handle(stateDir: string, raw: string, now: number): void {
  const payload: Payload = JSON.parse(raw) ?? {};
  const event = toStringOrEmpty(payload.hook_event_name);
  const id = toStringOrEmpty(payload.session_id);
  const status = STATUS_BY_EVENT.get(event);
  const isEnd = event === "SessionEnd";

  if (id === "" || (!isEnd && status === undefined)) return;

  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, "bob.db"), { timeout: BUSY_TIMEOUT_MS });

  try {
    db.exec("begin immediate");
    db.exec(SCHEMA);

    if (isEnd) {
      db.prepare("delete from sessions where session_id = ?").run(id);
    } else {
      const reason = event === "Notification" ? toStringOrEmpty(payload.message) : "";
      const cwd = toStringOrEmpty(payload.cwd);

      if (INSERTING_EVENTS.has(event)) {
        db.prepare(UPSERT).run(id, cwd, status ?? "", now, now, reason);
      } else {
        db.prepare(UPDATE).run(cwd, status ?? "", now, status ?? "", now, reason, id);
      }
    }

    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      void 0;
    }

    throw error;
  } finally {
    db.close();
  }
}
