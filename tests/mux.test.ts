import assert from "node:assert/strict";
import { test } from "node:test";
import { focus } from "../src/mux.ts";
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

test("tmux focus runs only select-window, select-pane, and switch-client on the stored pane", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("tmux", "work", "%12", run), { ok: true });
  assert.deepEqual(calls, [
    ["tmux", "select-window", "-t", "%12"],
    ["tmux", "select-pane", "-t", "%12"],
    ["tmux", "switch-client", "-t", "%12"],
  ]);
});

test("no recorded command is send-keys or a write", () => {
  const { calls, run } = recorder();
  focus("tmux", "work", "%1", run);
  const verbs = calls.map((argv) => argv[1]);
  assert.ok(!verbs.some((verb) => /send|write|paste|run-shell|pipe/.test(verb ?? "")));
});

for (const pane of ["%1; rm -rf /", "%1 %2", "$(id)", "%", "%a1", "1", "%1\n", "-t", "%1`id`"]) {
  test(`pane ${JSON.stringify(pane)} runs no command`, () => {
    const { calls, run } = recorder();
    const result = focus("tmux", "work", pane, run);
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  });
}

test("an empty pane gives the no-pane message and runs no command", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("tmux", "work", "", run), { ok: false, message: "no pane for this session" });
  assert.deepEqual(calls, []);
});

test("a failed command gives its reason and stops", () => {
  const { calls, run } = recorder({ ok: false, reason: "can't find pane: %9" });
  assert.deepEqual(focus("tmux", "work", "%9", run), { ok: false, message: "can't find pane: %9" });
  assert.equal(calls.length, 1);
});

test("a missing binary gives a message and does not throw", () => {
  const run = (): RunResult => {
    throw new Error("spawn tmux ENOENT");
  };

  const result = focus("tmux", "work", "%1", run);
  assert.equal(result.ok, false);
});

test("zellij and unknown multiplexers give a message and run no command", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("zellij", "work", "3", run), { ok: false, message: "zellij is not supported yet" });
  assert.equal(focus("", "", "%1", run).ok, false);
  assert.deepEqual(calls, []);
});
