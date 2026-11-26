import { isAbsolute } from "node:path";
import { Multiplexers } from "./multiplexer.ts";
import type { Multiplexer } from "./multiplexer.ts";
import type { Run, RunResult } from "./mux.ts";

const TMUX_PANE_ID = /^%\d+$/;

export function restart(multiplexer: Multiplexer, _session: string, pane: string, cwd: string, run: Run): RunResult {
  if (multiplexer === Multiplexers.zellij) return { ok: false, message: "restart not supported in zellij" };

  if (pane === "") return { ok: false, message: "no pane for this session" };

  if (multiplexer !== Multiplexers.tmux) return { ok: false, message: "no multiplexer for this session" };

  if (!TMUX_PANE_ID.test(pane)) return { ok: false, message: "pane id is not a tmux pane id" };

  if (!isAbsolute(cwd)) return { ok: false, message: "no folder for this row" };

  try {
    return run(["tmux", "respawn-pane", "-k", "-t", pane, "-c", cwd, "claude", "--continue"]);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
