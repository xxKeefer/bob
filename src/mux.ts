import { spawnSync } from "node:child_process";
import { Multiplexers } from "./multiplexer.ts";
import type { Multiplexer } from "./multiplexer.ts";

export type RunResult = { ok: true } | { ok: false; message: string };

export type Run = (argv: string[]) => RunResult;

const TMUX_PANE_ID = /^%\d+$/;
const ZELLIJ_PANE_ID = /^(terminal_)?\d+$/;
const ZELLIJ_SESSION = /^[^-\s][^\n]*$/;
const RUN_TIMEOUT_MS = 2000;

export const realRun: Run = (argv) => {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS, stdio: ["ignore", "ignore", "pipe"] });

  if (result.error !== undefined) {
    const code = "code" in result.error ? result.error.code : undefined;

    return { ok: false, message: code === "ENOENT" ? `${command} not found` : result.error.message };
  }

  if (result.status === 0) return { ok: true };

  return { ok: false, message: result.stderr.trim().split("\n")[0] || `${command} exited with ${result.status}` };
};

function focusTmux(pane: string, run: Run): RunResult {
  if (!TMUX_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a tmux pane id" };

  const verbs = ["select-window", "select-pane", "switch-client"];

  for (const verb of verbs) {
    const result = run(["tmux", verb, "-t", pane]);

    if (!result.ok) return result;
  }

  return { ok: true };
}

function focusZellij(session: string, pane: string, run: Run): RunResult {
  if (!ZELLIJ_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a zellij pane id" };

  if (!ZELLIJ_SESSION.test(session)) return { ok: false, message: "no zellij session for this session" };

  const result = run(["zellij", "--session", session, "action", "focus-pane-id", pane]);

  return result;
}

export function focus(multiplexer: Multiplexer, session: string, pane: string, run: Run): RunResult {
  if (pane === "") return { ok: false, message: "no pane for this session" };

  try {
    if (multiplexer === Multiplexers.tmux) return focusTmux(pane, run);

    if (multiplexer === Multiplexers.zellij) return focusZellij(session, pane, run);

    return { ok: false, message: "no multiplexer for this session" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
