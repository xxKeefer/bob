import { loadConfig } from "./config.ts";
import { openWindow } from "./mux.ts";
import type { Capture, Run, RunResult } from "./mux.ts";

const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export function isTicketKey(key: string): boolean {
  return TICKET_KEY.test(key);
}

function worktreePath(stdout: string, key: string): string | undefined {
  try {
    const list: { branch?: string; path?: string }[] = JSON.parse(stdout);

    return Array.isArray(list) ? list.find((entry) => entry.branch === key)?.path : undefined;
  } catch {
    return undefined;
  }
}

export function newTicket(
  key: string,
  env: Record<string, string | undefined>,
  home: string,
  run: Run,
  capture: Capture,
): RunResult {
  if (!isTicketKey(key)) return { ok: false, message: "ticket key looks like ABC-123" };

  const config = loadConfig(env, home);

  if (!config.ok) return config;

  const created = capture(["wt", "switch", "--create", key], config.repo);

  if (!created.ok) return created;

  const listed = capture(["wt", "list", "--format=json"], config.repo);

  if (!listed.ok) return listed;

  const path = worktreePath(listed.stdout, key);

  if (path === undefined) return { ok: false, message: `no worktree found for ${key}` };

  return openWindow(env, path, config.startPrompt.replaceAll("<KEY>", key), run);
}
