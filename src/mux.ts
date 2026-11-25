import { spawnSync } from "node:child_process";

export type RunResult = { ok: true } | { ok: false; reason: string };

export type Run = (argv: string[]) => RunResult;

export type FocusResult = { ok: true } | { ok: false; message: string };

const TMUX_PANE_ID = /^%\d+$/;
const RUN_TIMEOUT_MS = 2000;

export const realRun: Run = (argv) => {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS, stdio: ["ignore", "ignore", "pipe"] });

  if (result.error !== undefined) {
    const code = "code" in result.error ? result.error.code : undefined;

    return { ok: false, reason: code === "ENOENT" ? `${command} not found` : result.error.message };
  }

  if (result.status === 0) return { ok: true };

  return { ok: false, reason: result.stderr.trim().split("\n")[0] || `${command} exited with ${result.status}` };
};

function focusTmux(pane: string, run: Run): FocusResult {
  if (!TMUX_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a tmux pane id" };

  const commands = ["select-window", "select-pane", "switch-client"];

  for (const verb of commands) {
    const result = run(["tmux", verb, "-t", pane]);

    if (!result.ok) return { ok: false, message: result.reason };
  }

  return { ok: true };
}

export function focus(mux: string, _session: string, pane: string, run: Run): FocusResult {
  if (pane === "") return { ok: false, message: "no pane for this session" };

  try {
    if (mux === "tmux") return focusTmux(pane, run);

    if (mux === "zellij") return { ok: false, message: "zellij is not supported yet" };

    return { ok: false, message: "no multiplexer for this session" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
