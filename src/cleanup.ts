import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { closeWindow } from "./mux.ts";
import type { Capture, Run, RunResult } from "./mux.ts";
import type { Multiplexer } from "./multiplexer.ts";
import { parsePr } from "./pr.ts";

const BUSY_TIMEOUT_MS = 200;
const BRANCH = /^[^-\s]\S*$/;

export interface CleanupRow {
  sessionId: string;
  cwd: string;
  multiplexer: Multiplexer;
  muxSession: string;
  paneId: string;
}

export interface CleanupDeps {
  env: Record<string, string | undefined>;
  home: string;
  run: Run;
  capture: Capture;
  remove: () => void;
}

export function deleteRow(stateDir: string, sessionId: string): void {
  const db = new DatabaseSync(join(stateDir, "bob.db"), { timeout: BUSY_TIMEOUT_MS });

  try {
    db.prepare("delete from sessions where session_id = ?").run(sessionId);
  } finally {
    db.close();
  }
}

export function cleanup(row: CleanupRow, deps: CleanupDeps): RunResult {
  const { env, home, run, capture, remove } = deps;

  try {
    const head = capture(["git", "rev-parse", "--abbrev-ref", "HEAD"], row.cwd);

    if (!head.ok) return head;

    const branch = head.stdout.trim();

    if (branch === "HEAD" || !BRANCH.test(branch)) return { ok: false, message: "row is not on a branch" };

    const view = capture(["gh", "pr", "view", branch, "--json", "state,isDraft"], row.cwd);

    if (!view.ok) return { ok: false, message: `PR not merged: ${view.message}` };

    if (parsePr(view.stdout)?.state !== "merged") return { ok: false, message: "PR not merged, nothing removed" };

    const config = loadConfig(env, home);

    if (!config.ok) return config;

    const removed = capture(["wt", "remove", branch], config.repo);

    if (!removed.ok) return removed;

    const closed = row.paneId === "" ? { ok: true as const } : closeWindow(row.multiplexer, row.muxSession, row.paneId, run);

    remove();

    return closed.ok ? { ok: true } : { ok: false, message: `worktree removed, window not closed: ${closed.message}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
