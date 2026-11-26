import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Capture, RunResult } from "../src/mux.ts";
import { isPrNumber, newReview } from "../src/review.ts";

function setup(config: Record<string, string> = { repo: "/r/app" }, branch = "feat/x") {
  const dir = mkdtempSync(join(tmpdir(), "bob-review-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const captured: { argv: string[]; cwd: string }[] = [];
  const ran: string[][] = [];
  const marked: string[] = [];

  const capture: Capture = (argv, cwd) => {
    captured.push({ argv, cwd });

    if (argv[0] === "gh") return { ok: true, stdout: JSON.stringify({ headRefName: branch }) };

    if (argv[1] === "list") return { ok: true, stdout: JSON.stringify([{ branch: "main", path: "/r/app" }, { branch, path: "/r/app.x" }]) };

    return { ok: true, stdout: "" };
  };

  const run = (argv: string[]): RunResult => (ran.push(argv), { ok: true });

  return { env: { BOB_CONFIG_DIR: dir, TMUX: "x" }, captured, ran, marked, capture, run, mark: (path: string) => void marked.push(path) };
}

for (const n of ["1", "27", "0042"]) test(`${n} is a PR number`, () => assert.equal(isPrNumber(n), true));

for (const n of ["", "-1", "1 ", "1\n", "1;id", "abc", "1.5", "$(id)"]) {
  test(`${JSON.stringify(n)} is not a PR number`, () => assert.equal(isPrNumber(n), false));
}

test("a good number finds the branch, switches without create, opens a window, and marks the folder", () => {
  const s = setup();
  assert.deepEqual(newReview("27", s.env, "/h", s.run, s.capture, s.mark), { ok: true });
  assert.deepEqual(s.captured[0], { argv: ["gh", "pr", "view", "27", "--json", "headRefName"], cwd: "/r/app" });
  assert.deepEqual(s.captured[1], { argv: ["wt", "switch", "feat/x"], cwd: "/r/app" });
  assert.deepEqual(s.captured[2]?.argv, ["wt", "list", "--format=json"]);
  assert.deepEqual(s.ran, [["tmux", "new-window", "-c", "/r/app.x", "claude", "/engineering:review-pr 27"]]);
  assert.deepEqual(s.marked, ["/r/app.x"]);
});

test("a configured review prompt replaces <N>", () => {
  const s = setup({ repo: "/r/app", reviewPrompt: "/look <N> now" });
  newReview("27", s.env, "/h", s.run, s.capture, s.mark);
  assert.equal(s.ran[0]?.at(-1), "/look 27 now");
});

test("a bad number runs nothing", () => {
  const s = setup();
  assert.equal(newReview("1;id", s.env, "/h", s.run, s.capture, s.mark).ok, false);
  assert.deepEqual(s.captured, []);
  assert.deepEqual(s.ran, []);
});

test("a failed gh lookup opens nothing and gives its reason", () => {
  const s = setup();
  const result = newReview("27", s.env, "/h", s.run, () => ({ ok: false, message: "no pull requests found" }), s.mark);
  assert.deepEqual(result, { ok: false, message: "no pull requests found" });
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.marked, []);
});

for (const [name, stdout] of [["unparseable", "nope"], ["a missing branch", "{}"], ["a dash branch", JSON.stringify({ headRefName: "-x" })], ["a spaced branch", JSON.stringify({ headRefName: "a b" })]]) {
  test(`${name} from gh opens nothing`, () => {
    const s = setup();
    assert.equal(newReview("27", s.env, "/h", s.run, () => ({ ok: true, stdout }), s.mark).ok, false);
    assert.deepEqual(s.ran, []);
  });
}

test("a failed window marks nothing", () => {
  const s = setup();
  const result = newReview("27", s.env, "/h", () => ({ ok: false, message: "boom" }), s.capture, s.mark);
  assert.equal(result.ok, false);
  assert.deepEqual(s.marked, []);
});

test("bob posts nothing to GitHub", () => {
  const s = setup();
  newReview("27", s.env, "/h", s.run, s.capture, s.mark);

  for (const { argv } of s.captured) assert.ok(!(argv[0] === "gh" && argv[1] === "pr" && argv[2] !== "view"));
});
