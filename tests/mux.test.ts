import assert from "node:assert/strict";
import { test } from "node:test";
import { closeWindow, focus, open, openWindow, realCapture, realRun } from "../src/mux.ts";
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

test("tmux focus runs only switch-client, select-window, and select-pane on the stored pane", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("tmux", "work", "%12", run), { ok: true });
  assert.deepEqual(calls, [
    ["tmux", "switch-client", "-t", "%12"],
    ["tmux", "select-window", "-t", "%12"],
    ["tmux", "select-pane", "-t", "%12"],
  ]);
});

test("a failed switch-client moves no focus", () => {
  const calls: string[][] = [];

  const run = (argv: string[]): RunResult => {
    calls.push(argv);

    return argv[1] === "switch-client" ? { ok: false, message: "no current client" } : { ok: true };
  };

  assert.deepEqual(focus("tmux", "work", "%12", run), { ok: false, message: "no current client" });
  assert.deepEqual(calls, [["tmux", "switch-client", "-t", "%12"]]);
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
  const { calls, run } = recorder({ ok: false, message: "can't find pane: %9" });
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

test("zellij focus runs only focus-pane-id on the stored session and pane", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("zellij", "work", "3", run), { ok: true });
  assert.deepEqual(calls, [["zellij", "--session", "work", "action", "focus-pane-id", "3"]]);
});

test("zellij accepts the terminal_ prefix form", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("zellij", "work", "terminal_3", run), { ok: true });
  assert.deepEqual(calls, [["zellij", "--session", "work", "action", "focus-pane-id", "terminal_3"]]);
});

for (const pane of ["3; rm -rf /", "3 4", "$(id)", "terminal_", "terminal_a", "%3", "3\n", "-3", "plugin_1"]) {
  test(`zellij pane ${JSON.stringify(pane)} runs no command`, () => {
    const { calls, run } = recorder();
    assert.equal(focus("zellij", "work", pane, run).ok, false);
    assert.deepEqual(calls, []);
  });
}

test("zellij with an empty pane gives the no-pane message and runs no command", () => {
  const { calls, run } = recorder();
  assert.deepEqual(focus("zellij", "work", "", run), { ok: false, message: "no pane for this session" });
  assert.deepEqual(calls, []);
});

test("a zellij failure gives its reason", () => {
  const { run } = recorder({ ok: false, message: "Pane with id Terminal(99) not found" });
  assert.deepEqual(focus("zellij", "work", "99", run), { ok: false, message: "Pane with id Terminal(99) not found" });
});

test("a zellij session name that is empty or starts with a dash runs no command", () => {
  const { calls, run } = recorder();
  assert.equal(focus("zellij", "", "3", run).ok, false);
  assert.equal(focus("zellij", "-x", "3", run).ok, false);
  assert.deepEqual(calls, []);
});

test("an unknown multiplexer gives a message and runs no command", () => {
  const { calls, run } = recorder();
  assert.equal(focus("", "", "%1", run).ok, false);
  assert.deepEqual(calls, []);
});

test("realRun gives a not-found reason for a missing binary", () => {
  assert.deepEqual(realRun(["bob-no-such-binary"]), { ok: false, message: "bob-no-such-binary not found" });
});

test("realRun gives the first stderr line when the command fails", () => {
  assert.deepEqual(realRun(["node", "-e", "console.error('x\\ny');process.exit(3)"]), { ok: false, message: "x" });
});

test("realRun gives a non-empty timeout reason for a command that outlives the timeout", () => {
  const result = realRun(["node", "-e", "setTimeout(()=>{},10000)"]);
  assert.equal(result.ok, false);
  const message = result.ok ? "" : result.message;
  assert.notEqual(message, "");
  assert.notEqual(message, "exited with null");
});

test("tmux open splits a pane in the folder running claude", () => {
  const { calls, run } = recorder();
  assert.deepEqual(open({ TMUX: "/tmp/tmux-1/default,1,0" }, "/w/a", run), { ok: true });
  assert.deepEqual(calls, [["tmux", "split-window", "-c", "/w/a", "claude"]]);
});

test("zellij open makes a pane in the folder running claude", () => {
  const { calls, run } = recorder();
  assert.deepEqual(open({ ZELLIJ: "0" }, "/w/a", run), { ok: true });
  assert.deepEqual(calls, [["zellij", "action", "new-pane", "--cwd", "/w/a", "--", "claude"]]);
});

test("zellij wins when tmux and zellij are both set", () => {
  const { calls, run } = recorder();
  open({ TMUX: "x", ZELLIJ: "0" }, "/w/a", run);
  assert.equal(calls[0]?.[0], "zellij");
});

test("open with no multiplexer gives the message and runs no command", () => {
  const { calls, run } = recorder();
  assert.deepEqual(open({}, "/w/a", run), { ok: false, message: "launch needs tmux or zellij" });
  assert.deepEqual(calls, []);
});

for (const cwd of ["", "relative", "-x"]) {
  test(`open with folder ${JSON.stringify(cwd)} runs no command`, () => {
    const { calls, run } = recorder();
    assert.deepEqual(open({ TMUX: "x" }, cwd, run), { ok: false, message: "no folder for this row" });
    assert.deepEqual(calls, []);
  });
}

test("open sends no input to any pane", () => {
  for (const env of [{ TMUX: "x" }, { ZELLIJ: "0" }]) {
    const { calls, run } = recorder();
    open(env, "/w/a", run);
    assert.ok(!calls.flat().some((arg) => /send-keys|write-chars|write|paste/.test(arg)));
  }
});

test("open gives the failure reason, and a thrown runner does not escape", () => {
  assert.deepEqual(open({ TMUX: "x" }, "/w/a", () => ({ ok: false, message: "boom" })), { ok: false, message: "boom" });

  const result = open({ TMUX: "x" }, "/w/a", () => {
    throw new Error("spawn tmux ENOENT");
  });

  assert.deepEqual(result, { ok: false, message: "spawn tmux ENOENT" });
});

test("tmux openWindow makes a window in the folder running claude with the prompt as one argument", () => {
  const { calls, run } = recorder();
  assert.deepEqual(openWindow({ TMUX: "x" }, "/w/a", "/go A-1", run), { ok: true });
  assert.deepEqual(calls, [["tmux", "new-window", "-c", "/w/a", "claude", "/go A-1"]]);
});

test("zellij openWindow makes a pane in the folder running claude with the prompt", () => {
  const { calls, run } = recorder();
  assert.deepEqual(openWindow({ ZELLIJ: "0" }, "/w/a", "/go A-1", run), { ok: true });
  assert.deepEqual(calls, [["zellij", "action", "new-pane", "--cwd", "/w/a", "--", "claude", "/go A-1"]]);
});

test("openWindow refuses a bad folder, a dashed prompt, and no multiplexer", () => {
  const { calls, run } = recorder();
  assert.equal(openWindow({ TMUX: "x" }, "rel", "/go", run).ok, false);
  assert.equal(openWindow({ TMUX: "x" }, "/w/a", "-x", run).ok, false);
  assert.equal(openWindow({}, "/w/a", "/go", run).ok, false);
  assert.deepEqual(calls, []);
});

test("realCapture gives stdout, and a reason on failure", () => {
  assert.deepEqual(realCapture(["node", "-e", "process.stdout.write('hi')"], process.cwd()), { ok: true, stdout: "hi" });
  assert.deepEqual(realCapture(["bob-no-such-binary"], process.cwd()), { ok: false, message: "bob-no-such-binary not found" });
  assert.deepEqual(realCapture(["node", "-e", "console.error('x');process.exit(2)"], process.cwd()), { ok: false, message: "x" });
});

test("tmux closeWindow kills the window of the stored pane", () => {
  const { calls, run } = recorder();
  assert.deepEqual(closeWindow("tmux", "work", "%12", run), { ok: true });
  assert.deepEqual(calls, [["tmux", "kill-window", "-t", "%12"]]);
});

test("zellij closeWindow closes the stored pane in its session", () => {
  const { calls, run } = recorder();
  assert.deepEqual(closeWindow("zellij", "work", "3", run), { ok: true });
  assert.deepEqual(calls, [["zellij", "--session", "work", "action", "close-pane", "--pane-id", "3"]]);
});

test("closeWindow refuses a bad pane, a bad session, and no multiplexer", () => {
  const { calls, run } = recorder();
  assert.equal(closeWindow("tmux", "w", "%1; id", run).ok, false);
  assert.equal(closeWindow("tmux", "w", "", run).ok, false);
  assert.equal(closeWindow("zellij", "-x", "3", run).ok, false);
  assert.equal(closeWindow("zellij", "w", "3 4", run).ok, false);
  assert.equal(closeWindow("", "", "%1", run).ok, false);
  assert.deepEqual(calls, []);
});

test("a thrown runner does not escape closeWindow", () => {
  const result = closeWindow("tmux", "w", "%1", () => {
    throw new Error("spawn tmux ENOENT");
  });

  assert.deepEqual(result, { ok: false, message: "spawn tmux ENOENT" });
});
