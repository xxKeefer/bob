import assert from "node:assert/strict";
import { test } from "node:test";
import { restart } from "../src/restart.ts";
import type { RunResult } from "../src/mux.ts";

function recorder(result: RunResult = { ok: true }) {
  const calls: string[][] = [];

  return {
    calls,
    run: (argv: string[]): RunResult => {
      calls.push(argv);

      return result;
    },
  };
}

test("tmux restart respawns the pane in the row folder with claude --continue", () => {
  const { calls, run } = recorder();
  assert.deepEqual(restart("tmux", "s", "%7", "/w/a", run), { ok: true });
  assert.deepEqual(calls, [["tmux", "respawn-pane", "-k", "-t", "%7", "-c", "/w/a", "claude", "--continue"]]);
});

test("restart refuses a bad pane id, a relative folder, no pane, and no multiplexer, and runs nothing", () => {
  const { calls, run } = recorder();
  assert.equal(restart("tmux", "s", "%7;rm", "/w/a", run).ok, false);
  assert.equal(restart("tmux", "s", "-t", "/w/a", run).ok, false);
  assert.equal(restart("tmux", "s", "%7", "w/a", run).ok, false);
  assert.equal(restart("tmux", "s", "", "/w/a", run).ok, false);
  assert.equal(restart("", "s", "%7", "/w/a", run).ok, false);
  assert.deepEqual(calls, []);
});

test("zellij restart says it is not supported and runs nothing", () => {
  const { calls, run } = recorder();
  assert.deepEqual(restart("zellij", "zs", "4", "/w/a", run), { ok: false, message: "restart not supported in zellij" });
  assert.deepEqual(calls, []);
});

test("a failed respawn returns the message, and a throw becomes a message", () => {
  assert.deepEqual(restart("tmux", "s", "%7", "/w/a", recorder({ ok: false, message: "no pane" }).run), { ok: false, message: "no pane" });

  const result = restart("tmux", "s", "%7", "/w/a", () => {
    throw new Error("boom");
  });

  assert.deepEqual(result, { ok: false, message: "boom" });
});
