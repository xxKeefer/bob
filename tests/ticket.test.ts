import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Capture, RunResult } from "../src/mux.ts";
import { isTicketKey, newTicket } from "../src/ticket.ts";

function setup(config: Record<string, string> = { repo: "/r/app" }) {
  const dir = mkdtempSync(join(tmpdir(), "bob-ticket-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const captured: { argv: string[]; cwd: string }[] = [];
  const ran: string[][] = [];

  const capture: Capture = (argv, cwd) => {
    captured.push({ argv, cwd });

    if (argv[1] === "list") return { ok: true, stdout: JSON.stringify([{ branch: "main", path: "/r/app" }, { branch: "ABC-12", path: "/r/app.ABC-12" }]) };

    return { ok: true, stdout: "" };
  };

  const run = (argv: string[]): RunResult => (ran.push(argv), { ok: true });

  return { env: { BOB_CONFIG_DIR: dir, TMUX: "x" }, captured, ran, capture, run };
}

for (const key of ["ABC-1", "a-22", "AB2-345"]) {
  test(`${key} is a ticket key`, () => assert.equal(isTicketKey(key), true));
}

for (const key of ["", "ABC", "-1", "1-1", "ABC-", "ABC-1 ", "ABC-1\n", "ABC-1;id", "--x-1", "ABC-1-2", "$(id)-1"]) {
  test(`${JSON.stringify(key)} is not a ticket key`, () => assert.equal(isTicketKey(key), false));
}

test("a good key makes the worktree in the repo, then opens a window with the prompt", () => {
  const s = setup();
  assert.deepEqual(newTicket("ABC-12", s.env, "/h", s.run, s.capture), { ok: true });
  assert.deepEqual(s.captured[0], { argv: ["wt", "switch", "--create", "ABC-12"], cwd: "/r/app" });
  assert.deepEqual(s.captured[1]?.argv, ["wt", "list", "--format=json"]);
  assert.deepEqual(s.ran, [["tmux", "new-window", "-c", "/r/app.ABC-12", "claude", "/engineering:work-on ABC-12"]]);
});

test("a configured prompt replaces <KEY>", () => {
  const s = setup({ repo: "/r/app", startPrompt: "/do <KEY> now" });
  newTicket("ABC-12", s.env, "/h", s.run, s.capture);
  assert.equal(s.ran[0]?.at(-1), "/do ABC-12 now");
});

test("a bad key runs nothing", () => {
  const s = setup();
  const result = newTicket("ABC-1;id", s.env, "/h", s.run, s.capture);
  assert.equal(result.ok, false);
  assert.deepEqual(s.captured, []);
  assert.deepEqual(s.ran, []);
});

test("a missing config runs nothing", () => {
  const s = setup();
  const result = newTicket("ABC-12", { BOB_CONFIG_DIR: "/nonexistent-bob", TMUX: "x" }, "/h", s.run, s.capture);
  assert.equal(result.ok, false);
  assert.deepEqual(s.captured, []);
});

test("a failed wt switch opens no window and gives its reason", () => {
  const s = setup();
  const result = newTicket("ABC-12", s.env, "/h", s.run, () => ({ ok: false, message: "branch exists" }));
  assert.deepEqual(result, { ok: false, message: "branch exists" });
  assert.deepEqual(s.ran, []);
});

test("a worktree missing from the list opens no window", () => {
  const s = setup();
  const capture: Capture = (argv) => ({ ok: true, stdout: argv[1] === "list" ? "[]" : "" });
  assert.equal(newTicket("ABC-12", s.env, "/h", s.run, capture).ok, false);
  assert.deepEqual(s.ran, []);
});

test("unparseable list output opens no window", () => {
  const s = setup();
  const capture: Capture = () => ({ ok: true, stdout: "nope" });
  assert.equal(newTicket("ABC-12", s.env, "/h", s.run, capture).ok, false);
  assert.deepEqual(s.ran, []);
});
