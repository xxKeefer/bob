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

export type Launched = { ok: true; path: string } | { ok: false; message: string };

export function launch(
  config: { repo: string },
  switchArgs: string[],
  branch: string,
  prompt: string,
  env: Record<string, string | undefined>,
  run: Run,
  capture: Capture,
): Launched {
  const switched = capture(["wt", "switch", ...switchArgs, branch], config.repo);

  if (!switched.ok) return switched;

  const listed = capture(["wt", "list", "--format=json"], config.repo);

  if (!listed.ok) return listed;

  const path = worktreePath(listed.stdout, branch);

  if (path === undefined) return { ok: false, message: `no worktree found for ${branch}` };

  const opened = openWindow(env, path, prompt, run);

  return opened.ok ? { ok: true, path } : opened;
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

  const launched = launch(config, ["--create"], key, config.startPrompt.replaceAll("<KEY>", key), env, run, capture);

  return launched.ok ? { ok: true } : launched;
}
