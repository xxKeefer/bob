import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrCache, parsePr } from "../src/pr.ts";
import type { Exec, ExecResult } from "../src/pr.ts";

interface Overrides {
  state?: string;
  isDraft?: boolean;
  statusCheckRollup?: Record<string, string>[];
  reviewDecision?: string;
}

function json(extra: Overrides): string {
  return JSON.stringify({ state: "OPEN", isDraft: false, statusCheckRollup: [], reviewDecision: "", ...extra });
}

test("parsePr maps draft, open, merged, and closed", () => {
  assert.equal(parsePr(json({ isDraft: true }))?.state, "draft");
  assert.equal(parsePr(json({}))?.state, "open");
  assert.equal(parsePr(json({ state: "MERGED" }))?.state, "merged");
  assert.equal(parsePr(json({ state: "CLOSED" }))?.state, "closed");
});

test("parsePr maps the check rollup to pass, fail, pending, or none", () => {
  const run = (status: string, conclusion: string) => ({ __typename: "CheckRun", status, conclusion });
  assert.equal(parsePr(json({}))?.ci, "none");
  assert.equal(parsePr(json({ statusCheckRollup: [run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED")] }))?.ci, "pass");
  assert.equal(parsePr(json({ statusCheckRollup: [run("COMPLETED", "SUCCESS"), run("COMPLETED", "FAILURE")] }))?.ci, "fail");
  assert.equal(parsePr(json({ statusCheckRollup: [run("COMPLETED", "SUCCESS"), run("IN_PROGRESS", "")] }))?.ci, "pending");
  assert.equal(parsePr(json({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] }))?.ci, "fail");
  assert.equal(parsePr(json({ statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] }))?.ci, "pending");
  assert.equal(parsePr(json({ statusCheckRollup: [{ __typename: "StatusContext", state: "SUCCESS" }] }))?.ci, "pass");
});

test("parsePr maps the review decision", () => {
  assert.equal(parsePr(json({ reviewDecision: "APPROVED" }))?.review, "approved");
  assert.equal(parsePr(json({ reviewDecision: "CHANGES_REQUESTED" }))?.review, "changes");
  assert.equal(parsePr(json({ reviewDecision: "REVIEW_REQUIRED" }))?.review, "required");
  assert.equal(parsePr(json({ reviewDecision: "" }))?.review, "none");
});

test("parsePr returns undefined for bad json", () => {
  assert.equal(parsePr("nope"), undefined);
  assert.equal(parsePr("[]"), undefined);
});

interface Pending {
  argv: string[];
  cwd: string;
  resolve: (result: ExecResult) => void;
}

interface Fake {
  exec: Exec;
  calls: Pending[];
  ghCalls: () => Pending[];
}

function fake(): Fake {
  const calls: Pending[] = [];
  const exec: Exec = (argv, cwd) => new Promise((resolve) => calls.push({ argv, cwd, resolve }));

  return { exec, calls, ghCalls: () => calls.filter((call) => call.argv[0] === "gh") };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(calls: Pending[], branch: string, gh: ExecResult) {
  await tick();
  const git = calls.find((call) => call.argv[0] === "git" && !("done" in call));
  git?.resolve({ ok: true, stdout: `${branch}\n` });
  Object.assign(git ?? {}, { done: true });
  await tick();
  const pending = calls.filter((call) => call.argv[0] === "gh" && !("done" in call));

  for (const call of pending) {
    call.resolve(gh);
    Object.assign(call, { done: true });
  }

  await tick();
}

test("cache finds the branch with git argv and asks gh about it in the folder", async () => {
  const { exec, calls } = fake();
  const cache = createPrCache({ exec, now: () => 0 });
  cache.get("/w/a");
  await settle(calls, "feat/x", { ok: true, stdout: json({}) });
  assert.deepEqual(calls[0]?.argv, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(calls[0]?.cwd, "/w/a");
  assert.deepEqual(calls[1]?.argv.slice(0, 4), ["gh", "pr", "view", "feat/x"]);
  assert.ok(calls[1]?.argv.includes("state,isDraft,statusCheckRollup,reviewDecision"));
  assert.equal(calls[1]?.cwd, "/w/a");
  assert.equal(cache.get("/w/a")?.state, "open");
});

test("cache keeps one call in flight for each key", async () => {
  const { exec, calls } = fake();
  const cache = createPrCache({ exec, now: () => 0 });
  cache.get("/w/a");
  cache.get("/w/a");
  cache.get("/w/a");
  assert.equal(calls.length, 1);
  cache.get("/w/b");
  assert.equal(calls.length, 2);
});

test("cache serves the value until the ttl, then refreshes and serves old data meanwhile", async () => {
  const { exec, calls, ghCalls } = fake();
  let now = 0;
  const cache = createPrCache({ exec, now: () => now, ttl: 30 });
  cache.get("/w/a");
  await settle(calls, "b", { ok: true, stdout: json({}) });
  now = 29;
  cache.get("/w/a");
  assert.equal(calls.length, 2);
  now = 30;
  assert.equal(cache.get("/w/a")?.ci, "none");
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(cache.get("/w/a")?.state, "open");
  await settle(calls, "b", { ok: true, stdout: json({ isDraft: true }) });
  assert.equal(ghCalls().length, 2);
  assert.equal(cache.get("/w/a")?.state, "draft");
});

test("cache backs off after an error, keeps old data, and retries later", async () => {
  const { exec, calls } = fake();
  let now = 0;
  const cache = createPrCache({ exec, now: () => now, ttl: 30, backoff: 60 });
  cache.get("/w/a");
  await settle(calls, "b", { ok: true, stdout: json({}) });
  now = 30;
  cache.get("/w/a");
  await settle(calls, "b", { ok: false, message: "network" });
  const before = calls.length;
  now = 89;
  assert.equal(cache.get("/w/a")?.state, "open");
  assert.equal(calls.length, before);
  now = 90;
  cache.get("/w/a");
  assert.ok(calls.length > before);
});

test("cache treats no pull request as a cached empty answer, not an error", async () => {
  const { exec, calls } = fake();
  let now = 0;
  const cache = createPrCache({ exec, now: () => now, ttl: 30, backoff: 600 });
  cache.get("/w/a");
  await settle(calls, "b", { ok: false, message: 'no pull requests found for branch "b"' });
  assert.equal(cache.get("/w/a"), undefined);
  const before = calls.length;
  now = 30;
  cache.get("/w/a");
  assert.ok(calls.length > before);
});

test("cache backs off when git fails or the branch is detached", async () => {
  const { exec, calls } = fake();
  const cache = createPrCache({ exec, now: () => 0 });
  cache.get("/w/a");
  await settle(calls, "HEAD", { ok: true, stdout: json({}) });
  assert.equal(calls.filter((call) => call.argv[0] === "gh").length, 0);
  assert.equal(cache.get("/w/a"), undefined);
});

test("cache never throws when exec rejects", async () => {
  const exec: Exec = () => Promise.reject(new Error("boom"));
  const cache = createPrCache({ exec, now: () => 0 });
  cache.get("/w/a");
  await tick();
  await tick();
  assert.equal(cache.get("/w/a"), undefined);
});
