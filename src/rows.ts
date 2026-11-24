import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readUsage } from "./transcript.ts";
import type { Usage } from "./transcript.ts";

export const STALE_SECONDS = 3600;
const BUSY_TIMEOUT_MS = 200;

export interface Row {
  sessionId: string;
  cwd: string;
  status: string;
  since: number;
  updated: number;
  reason: string;
  context: Usage | undefined;
}

const RANK = new Map([
  ["waiting", 0],
  ["busy", 1],
  ["idle", 2],
  ["stale", 3],
]);

function rank(status: string): number {
  return RANK.get(status) ?? RANK.size;
}

export function loadRows(stateDir: string, now: number, onError?: (error: Error) => void): Row[] {
  const file = join(stateDir, "bob.db");

  if (!existsSync(file)) return [];

  try {
    const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });

    try {
      const table = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sessions'").get();

      if (table === undefined) return [];

      const hasTranscript = db.prepare("pragma table_info(sessions)").all().some((column) => column.name === "transcript_path");
      const transcript = hasTranscript ? "transcript_path" : "'' as transcript_path";

      const found = db
        .prepare(`select session_id, cwd, status, since, updated, reason, ${transcript} from sessions`)
        .all();

      return found
        .map((row) => {
          const updated = Number(row.updated);
          const status = now - updated >= STALE_SECONDS ? "stale" : String(row.status);

          return {
            sessionId: String(row.session_id),
            cwd: String(row.cwd),
            status,
            since: Number(row.since),
            updated,
            reason: String(row.reason),
            context: readUsage(String(row.transcript_path)),
          };
        })
        .sort((a, b) => rank(a.status) - rank(b.status) || a.since - b.since);
    } finally {
      db.close();
    }
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));

    return [];
  }
}
