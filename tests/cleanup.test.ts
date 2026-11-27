import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanup, deleteRow } from "../src/cleanup.ts";
import { handle } from "../src/hook.ts";
import type { Capture, RunResult } from "../src/mux.ts";

function setup(prState = "MERGED", branch = "ABC-12\n") {
  const dir = mkdtempSync(join(tmpdir(), "bob-clean-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ repo: "/r/app" }));
  const captured: { argv: string[]; cwd: string }[] = [];
  const ran: string[][] = [];
  const order: string[] = [];

  const capture: Capture = (argv, cwd) => {
    captured.push({ argv, cwd });
    order.push(argv[0] === "wt" ? "wt" : argv[0] ?? "");

    if (argv[0] === "git") return { ok: true, stdout: branch };

    if (argv[0] === "gh") return { ok: true, stdout: JSON.stringify({ state: prState, isDraft: false }) };

    return { ok: true, stdout: "" };
  };

  const run = (argv: string[]): RunResult => (ran.push(argv), order.push("close"), { ok: true });
  const removed: string[] = [];
  const row = { sessionId: "s1", cwd: "/r/app.ABC-12", multiplexer: "tmux" as const, muxSession: "w", paneId: "%7" };
  const deps = { env: { BOB_CONFIG_DIR: dir }, home: "/h", run, capture, remove: () => (removed.push("s1"), order.push("row")) };

  return { row, deps, captured, ran, removed, order };
}

test("a merged PR removes the worktree, closes the window, then drops the row", () => {
  const s = setup();
  assert.deepEqual(cleanup(s.row, s.deps), { ok: true });
  assert.deepEqual(s.captured.find((c) => c.argv[0] === "wt"), { argv: ["wt", "remove", "ABC-12"], cwd: "/r/app" });
  assert.deepEqual(s.ran, [["tmux", "kill-window", "-t", "%7"]]);
  assert.deepEqual(s.removed, ["s1"]);
  assert.deepEqual(s.order, ["git", "gh", "wt", "close", "row"]);
});

for (const state of ["OPEN", "CLOSED"]) {
  test(`a ${state} PR is refused and nothing runs`, () => {
    const s = setup(state);
    const result = cleanup(s.row, s.deps);
    assert.equal(result.ok, false);
    assert.ok(!s.captured.some((c) => c.argv[0] === "wt"));
    assert.deepEqual(s.ran, []);
    assert.deepEqual(s.removed, []);
  });
}

test("a draft PR is refused", () => {
  const s = setup("OPEN");
  const capture: Capture = (argv) => (argv[0] === "git" ? { ok: true, stdout: "ABC-12\n" } : { ok: true, stdout: JSON.stringify({ state: "OPEN", isDraft: true }) });
  assert.equal(cleanup(s.row, { ...s.deps, capture }).ok, false);
  assert.deepEqual(s.removed, []);
});

test("no PR is refused", () => {
  const s = setup();

  const capture: Capture = (argv) =>
    argv[0] === "git" ? { ok: true, stdout: "ABC-12\n" } : { ok: false, message: "no pull requests found for branch" };

  assert.equal(cleanup(s.row, { ...s.deps, capture }).ok, false);
  assert.deepEqual(s.removed, []);
});

for (const branch of ["", "HEAD\n", "-x\n", "a b\n"]) {
  test(`branch ${JSON.stringify(branch)} is refused`, () => {
    const s = setup("MERGED", branch);
    assert.equal(cleanup(s.row, s.deps).ok, false);
    assert.ok(!s.captured.some((c) => c.argv[0] === "wt" || c.argv[0] === "gh"));
    assert.deepEqual(s.removed, []);
  });
}

test("a failed wt remove closes no window and drops no row", () => {
  const s = setup();

  const capture: Capture = (argv, cwd) => {
    if (argv[0] === "wt") return { ok: false, message: "dirty worktree" };

    return s.deps.capture(argv, cwd);
  };

  assert.deepEqual(cleanup(s.row, { ...s.deps, capture }), { ok: false, message: "dirty worktree" });
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.removed, []);
});

test("a missing config removes nothing", () => {
  const s = setup();
  const result = cleanup(s.row, { ...s.deps, env: { BOB_CONFIG_DIR: "/nonexistent-bob" } });
  assert.equal(result.ok, false);
  assert.ok(!s.captured.some((c) => c.argv[0] === "wt"));
});

test("a row with no pane skips the window close but still drops the row", () => {
  const s = setup();
  assert.deepEqual(cleanup({ ...s.row, paneId: "", multiplexer: "" }, s.deps), { ok: true });
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.removed, ["s1"]);
});

test("a failed window close still drops the row and says so", () => {
  const s = setup();
  const result = cleanup(s.row, { ...s.deps, run: () => ({ ok: false, message: "can't find window" }) });
  assert.equal(result.ok, false);
  assert.deepEqual(s.removed, ["s1"]);
});

test("deleteRow drops only the named row", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-del-"));

  for (const id of ["a", "b"]) handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: `/w/${id}` }), 1000);

  deleteRow(dir, "a");
  const db = new DatabaseSync(join(dir, "bob.db"));
  assert.deepEqual(db.prepare("select session_id from sessions").all().map((r) => r.session_id), ["b"]);
  db.close();
});
