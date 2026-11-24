import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "./hook.ts";
import { main } from "./view.ts";
import type { MainOptions } from "./view.ts";

const STALE_AGE_SECONDS = 4000;

function send(dir: string, now: number, ago: number, event: string, id: string, cwd: string, message = "") {
  handle(dir, JSON.stringify({ hook_event_name: event, session_id: id, cwd, message }), now - ago);
}

function seed(dir: string, now: number): void {
  send(dir, now, STALE_AGE_SECONDS, "SessionStart", "stale", "/work/old-experiment");
  send(dir, now, 1500, "SessionStart", "wait-a", "/work/api-server");
  send(dir, now, 1400, "Notification", "wait-a", "/work/api-server", "Allow Bash: npm test?");
  send(dir, now, 300, "SessionStart", "wait-b", "/work/web-app");
  send(dir, now, 200, "Notification", "wait-b", "/work/web-app", "Which database should I use?");
  send(dir, now, 600, "SessionStart", "busy", "/work/docs-site");
  send(dir, now, 95, "UserPromptSubmit", "busy", "/work/docs-site");
  send(dir, now, 800, "SessionStart", "idle", "/work/dotfiles");
  send(dir, now, 750, "Stop", "idle", "/work/dotfiles");
}

export async function demo(options: Omit<MainOptions, "stateDir">): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bob-demo-"));

  try {
    seed(dir, options.now());
    await main({ ...options, stateDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
