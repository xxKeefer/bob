import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { Multiplexers } from "./multiplexer.ts";
import type { Multiplexer } from "./multiplexer.ts";

export type RunResult = { ok: true } | { ok: false; message: string };

export type Run = (argv: string[]) => RunResult;

const TMUX_PANE_ID = /^%\d+$/;
const ZELLIJ_PANE_ID = /^(terminal_)?\d+$/;
const ZELLIJ_SESSION = /^[^-\s][^\n]*$/;
const RUN_TIMEOUT_MS = 2000;
const CAPTURE_TIMEOUT_MS = 120000;

export type CaptureResult = { ok: true; stdout: string } | { ok: false; message: string };

export type Capture = (argv: string[], cwd: string) => CaptureResult;

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

export const realCapture: Capture = (argv, cwd) => {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, { encoding: "utf8", timeout: CAPTURE_TIMEOUT_MS, cwd, stdio: ["ignore", "pipe", "pipe"] });

  if (result.error !== undefined) {
    const code = "code" in result.error ? result.error.code : undefined;

    return { ok: false, message: code === "ENOENT" ? `${command} not found` : result.error.message };
  }

  if (result.status === 0) return { ok: true, stdout: result.stdout };

  return { ok: false, message: result.stderr.trim().split("\n")[0] || `${command} exited with ${result.status}` };
};

function focusTmux(pane: string, run: Run): RunResult {
  if (!TMUX_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a tmux pane id" };

  const verbs = ["switch-client", "select-window", "select-pane"];

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

export function open(env: Record<string, string | undefined>, cwd: string, run: Run): RunResult {
  if (!isAbsolute(cwd)) return { ok: false, message: "no folder for this row" };

  let argv: string[];

  if (env.ZELLIJ !== undefined) argv = ["zellij", "action", "new-pane", "--cwd", cwd, "--", "claude"];
  else if (env.TMUX !== undefined) argv = ["tmux", "split-window", "-c", cwd, "claude"];
  else return { ok: false, message: "launch needs tmux or zellij" };

  try {
    return run(argv);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function openWindow(env: Record<string, string | undefined>, cwd: string, prompt: string, run: Run): RunResult {
  if (!isAbsolute(cwd)) return { ok: false, message: "no folder for this row" };

  if (prompt === "" || prompt.startsWith("-")) return { ok: false, message: "start prompt is not valid" };

  let argv: string[];

  if (env.ZELLIJ !== undefined) argv = ["zellij", "action", "new-pane", "--cwd", cwd, "--", "claude", prompt];
  else if (env.TMUX !== undefined) argv = ["tmux", "new-window", "-c", cwd, "claude", prompt];
  else return { ok: false, message: "launch needs tmux or zellij" };

  try {
    return run(argv);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function openPane(env: Record<string, string | undefined>, cwd: string, command: string[], run: Run): RunResult {
  if (!isAbsolute(cwd)) return { ok: false, message: "no folder for this row" };

  if (command.length === 0) return { ok: false, message: "no command to run" };

  let argv: string[];

  if (env.ZELLIJ !== undefined) argv = ["zellij", "action", "new-pane", "--cwd", cwd, "--", ...command];
  else if (env.TMUX !== undefined) argv = ["tmux", "new-window", "-d", "-c", cwd, ...command];
  else return { ok: false, message: "launch needs tmux or zellij" };

  try {
    return run(argv);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function closeWindow(multiplexer: Multiplexer, session: string, pane: string, run: Run): RunResult {
  if (pane === "") return { ok: false, message: "no pane for this session" };

  let argv: string[];

  if (multiplexer === Multiplexers.tmux) {
    if (!TMUX_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a tmux pane id" };

    argv = ["tmux", "kill-window", "-t", pane];
  } else if (multiplexer === Multiplexers.zellij) {
    if (!ZELLIJ_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a zellij pane id" };

    if (!ZELLIJ_SESSION.test(session)) return { ok: false, message: "no zellij session for this session" };

    argv = ["zellij", "--session", session, "action", "close-pane", "--pane-id", pane];
  } else return { ok: false, message: "no multiplexer for this session" };

  try {
    return run(argv);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
