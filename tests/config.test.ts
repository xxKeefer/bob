import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, loadPlanDir } from "../src/config.ts";

function dirWith(text: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "bob-config-"));

  if (text !== undefined) writeFileSync(join(dir, "config.json"), text);

  return dir;
}

test("a config with a repo and a start prompt loads", () => {
  const dir = dirWith(JSON.stringify({ repo: "/r/app", startPrompt: "/go <KEY>" }));
  assert.deepEqual(loadConfig({ BOB_CONFIG_DIR: dir }, "/h"), {
    ok: true,
    repo: "/r/app",
    startPrompt: "/go <KEY>",
    reviewPrompt: "/engineering:review-pr <N>",
  });
});

test("the start prompt defaults to work-on", () => {
  const dir = dirWith(JSON.stringify({ repo: "/r/app" }));
  assert.deepEqual(loadConfig({ BOB_CONFIG_DIR: dir }, "/h"), {
    ok: true,
    repo: "/r/app",
    startPrompt: "/engineering:work-on <KEY>",
    reviewPrompt: "/engineering:review-pr <N>",
  });
});

test("a configured review prompt loads", () => {
  const dir = dirWith(JSON.stringify({ repo: "/r/app", reviewPrompt: "/look <N>" }));
  const result = loadConfig({ BOB_CONFIG_DIR: dir }, "/h");
  assert.ok(result.ok && result.reviewPrompt === "/look <N>");
});

test("the config dir defaults to .config/bob under home", () => {
  const home = mkdtempSync(join(tmpdir(), "bob-home-"));
  mkdirSync(join(home, ".config", "bob"), { recursive: true });
  writeFileSync(join(home, ".config", "bob", "config.json"), JSON.stringify({ repo: "/r/app" }));
  assert.equal(loadConfig({}, home).ok, true);
});

for (const [name, text] of [
  ["a missing file", undefined],
  ["bad json", "{"],
  ["a non-object", "[]"],
  ["a missing repo", "{}"],
  ["a relative repo", JSON.stringify({ repo: "app" })],
  ["a non-string prompt", JSON.stringify({ repo: "/r", startPrompt: 4 })],
  ["a prompt that starts with a dash", JSON.stringify({ repo: "/r", startPrompt: "--x <KEY>" })],
  ["a review prompt that starts with a dash", JSON.stringify({ repo: "/r", reviewPrompt: "--x <N>" })],
  ["an empty review prompt", JSON.stringify({ repo: "/r", reviewPrompt: "" })],
  ["an empty prompt", JSON.stringify({ repo: "/r", startPrompt: "" })],
] as const) {
  test(`${name} gives a message`, () => {
    const result = loadConfig({ BOB_CONFIG_DIR: dirWith(text) }, "/h");
    assert.equal(result.ok, false);
  });
}

test("a relative BOB_CONFIG_DIR is refused", () => {
  assert.equal(loadConfig({ BOB_CONFIG_DIR: "rel" }, "/h").ok, false);
});

test("loadStuckSeconds defaults to 300 and reads a positive stuckSeconds", async () => {
  const { loadStuckSeconds } = await import("../src/config.ts");
  assert.equal(loadStuckSeconds({ BOB_CONFIG_DIR: dirWith(undefined) }, "/h"), 300);
  assert.equal(loadStuckSeconds({ BOB_CONFIG_DIR: dirWith("{bad") }, "/h"), 300);
  assert.equal(loadStuckSeconds({ BOB_CONFIG_DIR: dirWith(JSON.stringify({ repo: "/r" })) }, "/h"), 300);
  assert.equal(loadStuckSeconds({ BOB_CONFIG_DIR: dirWith(JSON.stringify({ stuckSeconds: 90 })) }, "/h"), 90);
  assert.equal(loadStuckSeconds({ BOB_CONFIG_DIR: dirWith(JSON.stringify({ stuckSeconds: -1 })) }, "/h"), 300);
  assert.equal(loadStuckSeconds({ BOB_CONFIG_DIR: dirWith(JSON.stringify({ stuckSeconds: "9" })) }, "/h"), 300);
});

test("the plan dir is the env override, then the config planDir, then the default", () => {
  const dir = dirWith(JSON.stringify({ repo: "/r", planDir: "/p/reports" }));
  assert.equal(loadPlanDir({ BOB_CONFIG_DIR: dir, BOB_PLAN_DIR: "/t/plans" }, "/h"), "/t/plans");
  assert.equal(loadPlanDir({ BOB_CONFIG_DIR: dir }, "/h"), "/p/reports");
  assert.equal(loadPlanDir({ BOB_CONFIG_DIR: dirWith(undefined) }, "/h"), "/h/studio/work/.ai/reports");
});

test("the plan dir ignores a relative or non-text value", () => {
  const dir = dirWith(JSON.stringify({ planDir: "rel" }));
  assert.equal(loadPlanDir({ BOB_CONFIG_DIR: dir, BOB_PLAN_DIR: "rel" }, "/h"), "/h/studio/work/.ai/reports");
  assert.equal(loadPlanDir({ BOB_CONFIG_DIR: dirWith(JSON.stringify({ planDir: 5 })) }, "/h"), "/h/studio/work/.ai/reports");
});
