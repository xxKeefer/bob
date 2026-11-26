import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readReviews } from "./reviews.ts";
import { toMultiplexer } from "./multiplexer.ts";
import type { Multiplexer } from "./multiplexer.ts";
import { readMtime, readUsage } from "./transcript.ts";
import type { Usage } from "./transcript.ts";

export const STALE_SECONDS = 3600;
export const DEFAULT_STUCK_SECONDS = 300;
const BUSY_TIMEOUT_MS = 200;

export interface Row {
  sessionId: string;
  cwd: string;
  status: string;
  since: number;
  updated: number;
  reason: string;
  context: Usage | undefined;
  multiplexer: Multiplexer;
  muxSession: string;
  paneId: string;
  review: boolean;
}

const RANK = new Map([
  ["waiting", 0],
  ["stuck", 1],
  ["busy", 2],
  ["idle", 3],
  ["stale", 4],
]);

function rank(status: string): number {
  return RANK.get(status) ?? RANK.size;
}

export function loadRows(stateDir: string, now: number, onError?: (error: Error) => void, stuckSeconds = DEFAULT_STUCK_SECONDS): Row[] {
  const file = join(stateDir, "bob.db");

  if (!existsSync(file)) return [];

  try {
    const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });

    try {
      const table = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sessions'").get();

      if (table === undefined) return [];

      const present = new Set(db.prepare("pragma table_info(sessions)").all().map((column) => String(column.name)));
      const optional = (name: string) => (present.has(name) ? name : `'' as ${name}`);
      const optionals = ["transcript_path", "multiplexer", "mux_session", "pane_id"].map(optional).join(", ");

      const found = db
        .prepare(`select session_id, cwd, status, since, updated, reason, ${optionals} from sessions`)
        .all();

      const reviews = readReviews(stateDir);

      return found
        .map((row) => {
          const updated = Number(row.updated);
          const transcript = String(row.transcript_path);
          let status = now - updated >= STALE_SECONDS ? "stale" : String(row.status);

          if (status === "busy") {
            const mtime = readMtime(transcript);

            if (mtime !== undefined && now - mtime >= stuckSeconds) status = "stuck";
          }

          return {
            sessionId: String(row.session_id),
            cwd: String(row.cwd),
            status,
            since: Number(row.since),
            updated,
            reason: String(row.reason),
            context: readUsage(transcript),
            multiplexer: toMultiplexer(String(row.multiplexer)),
            muxSession: String(row.mux_session),
            paneId: String(row.pane_id),
            review: reviews.has(String(row.cwd)),
          };
        })
        .sort((a, b) => rank(a.status) - rank(b.status) || Number(a.review) - Number(b.review) || a.since - b.since);
    } finally {
      db.close();
    }
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));

    return [];
  }
}
