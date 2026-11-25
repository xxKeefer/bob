import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STALE_SECONDS } from "./rows.ts";

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
  transcript_path?: string;
}

const SCHEMA =
  "create table if not exists sessions (session_id text primary key, cwd text not null, status text not null, since integer not null, updated integer not null, reason text not null, transcript_path text not null default '', multiplexer text not null default '', mux_session text not null default '', pane_id text not null default '')";

const ADDED_COLUMNS = ["transcript_path", "multiplexer", "mux_session", "pane_id"];

type TmuxLookup = (pane: string) => string;

interface Mux {
  multiplexer: string;
  session: string;
  pane: string;
}

function detectMux(env: Record<string, string | undefined>): Mux {
  const zellijPane = toStringOrEmpty(env.ZELLIJ_PANE_ID);

  if (zellijPane !== "") return { multiplexer: "zellij", session: toStringOrEmpty(env.ZELLIJ_SESSION_NAME), pane: zellijPane };

  return { multiplexer: "", session: "", pane: "" };
}

const UPSERT =
  "insert into sessions (session_id, cwd, status, since, updated, reason, transcript_path, multiplexer, mux_session, pane_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "on conflict(session_id) do update set cwd = excluded.cwd, " +
  "since = case when sessions.status = excluded.status and excluded.updated - sessions.updated < ? then sessions.since else excluded.since end, " +
  "status = excluded.status, updated = excluded.updated, reason = excluded.reason, " +
  "transcript_path = coalesce(nullif(excluded.transcript_path, ''), sessions.transcript_path), " +
  "multiplexer = coalesce(nullif(excluded.multiplexer, ''), sessions.multiplexer), " +
  "mux_session = coalesce(nullif(excluded.mux_session, ''), sessions.mux_session), " +
  "pane_id = coalesce(nullif(excluded.pane_id, ''), sessions.pane_id)";

const UPDATE =
  "update sessions set cwd = ?, " +
  "since = case when status = ? and ? - updated < ? then since else ? end, " +
  "status = ?, updated = ?, reason = ?, transcript_path = coalesce(nullif(?, ''), transcript_path), " +
  "multiplexer = coalesce(nullif(?, ''), multiplexer), mux_session = coalesce(nullif(?, ''), mux_session), " +
  "pane_id = coalesce(nullif(?, ''), pane_id) where session_id = ?";

function toStringOrEmpty(value: string | undefined): string {
  return String(value ?? "");
}

export function handle(
  stateDir: string,
  raw: string,
  now: number,
  env: Record<string, string | undefined> = {},
  _tmuxSession: TmuxLookup = () => "",
): void {
  const payload: Payload = JSON.parse(raw) ?? {};
  const event = toStringOrEmpty(payload.hook_event_name);
  const id = toStringOrEmpty(payload.session_id);
  const status = STATUS_BY_EVENT.get(event);
  const isEnd = event === "SessionEnd";

  if (id === "" || (!isEnd && status === undefined)) return;

  const mux = detectMux(env);

  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, "bob.db"), { timeout: BUSY_TIMEOUT_MS });

  try {
    db.exec("pragma synchronous = off");
    db.exec("begin immediate");
    db.exec(SCHEMA);

    const present = new Set(db.prepare("pragma table_info(sessions)").all().map((column) => column.name));

    for (const name of ADDED_COLUMNS) {
      if (!present.has(name)) db.exec("alter table sessions add column " + name + " text not null default ''");
    }

    if (isEnd) {
      db.prepare("delete from sessions where session_id = ?").run(id);
    } else {
      const reason = event === "Notification" ? toStringOrEmpty(payload.message) : "";
      const cwd = toStringOrEmpty(payload.cwd);
      const transcript = toStringOrEmpty(payload.transcript_path);

      if (INSERTING_EVENTS.has(event)) {
        db.prepare(UPSERT).run(id, cwd, status ?? "", now, now, reason, transcript, mux.multiplexer, mux.session, mux.pane, STALE_SECONDS);
      } else {
        db.prepare(UPDATE).run(cwd, status ?? "", now, STALE_SECONDS, now, status ?? "", now, reason, transcript, mux.multiplexer, mux.session, mux.pane, id);
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
