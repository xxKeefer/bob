import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STALE_SECONDS = 3600;

export interface Row {
  sessionId: string;
  cwd: string;
  status: string;
  since: number;
  updated: number;
  reason: string;
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

export function loadRows(stateDir: string, now: number): Row[] {
  const file = join(stateDir, "bob.db");

  if (!existsSync(file)) return [];

  try {
    const db = new DatabaseSync(file, { readOnly: true });

    try {
      const found = db
        .prepare("select session_id, cwd, status, since, updated, reason from sessions")
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
          };
        })
        .sort((a, b) => rank(a.status) - rank(b.status) || a.since - b.since);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
