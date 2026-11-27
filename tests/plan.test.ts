import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlanCache, parsePlan } from "../src/plan.ts";

const PLAN = [
  "---",
  "doctype: plan",
  "---",
  "## Acceptance criteria",
  "- [x] **A.** Not a step.",
  "## Steps",
  "- [x] **1. First.** Seam: x.",
  "  - Done: yes",
  "- [x] **2. Second.**",
  "- [-] **3. Third.**",
  "- [ ] **4. Fourth.**",
  "## Progress",
  "- [x] **5. Not here.**",
].join("\n");

test("parsePlan counts done and total steps under Steps only", () => {
  assert.deepEqual(parsePlan(PLAN), { done: 2, total: 4 });
});

test("parsePlan gives nothing when there is no Steps section or no step", () => {
  assert.equal(parsePlan("## Goal\nx"), undefined);
  assert.equal(parsePlan("## Steps\nnothing"), undefined);
});

function base(): string {
  return mkdtempSync(join(tmpdir(), "bob-plan-"));
}

function put(dir: string, key: string, name: string, text: string, mtime?: number): string {
  mkdirSync(join(dir, key), { recursive: true });
  const file = join(dir, key, name);
  writeFileSync(file, text);

  if (mtime !== undefined) utimesSync(file, mtime, mtime);

  return file;
}

test("the cache reads the plan for the ticket key in the folder name", () => {
  const dir = base();
  put(dir, "ABC-12", "plan_12.md", PLAN);
  assert.deepEqual(createPlanCache(dir).get("/w/ABC-12"), { done: 2, total: 4 });
});

test("the cache gives nothing for a folder with no plan or no key", () => {
  const dir = base();
  mkdirSync(join(dir, "ABC-1"));
  const cache = createPlanCache(dir);
  assert.equal(cache.get("/w/ABC-1"), undefined);
  assert.equal(cache.get("/w/ABC-2"), undefined);
  assert.equal(cache.get("/w/not-a-key"), undefined);
});

test("the cache refuses a folder name that is not a strict key", () => {
  const dir = base();
  put(dir, "..", "plan_x.md", PLAN);
  mkdirSync(join(dir, "x"), { recursive: true });
  put(join(dir, "x"), "ABC-1", "plan_1.md", PLAN);
  const cache = createPlanCache(join(dir, "x"));
  assert.equal(cache.get("/w/.."), undefined);
  assert.equal(cache.get("/w/ABC-1/../.."), undefined);
});

test("the cache picks up a step that finishes, by file mtime", () => {
  const dir = base();
  const file = put(dir, "ABC-3", "plan_3.md", PLAN, 1000);
  const cache = createPlanCache(dir);
  assert.deepEqual(cache.get("/w/ABC-3"), { done: 2, total: 4 });
  writeFileSync(file, PLAN.replace("- [ ] **4.", "- [x] **4."));
  utimesSync(file, 2000, 2000);
  assert.deepEqual(cache.get("/w/ABC-3"), { done: 3, total: 4 });
});

test("the cache does not reread a file whose mtime is unchanged", () => {
  const dir = base();
  const file = put(dir, "ABC-4", "plan_4.md", PLAN, 1000);
  const cache = createPlanCache(dir);
  cache.get("/w/ABC-4");
  writeFileSync(file, PLAN.replace("- [ ] **4.", "- [x] **4."));
  utimesSync(file, 1000, 1000);
  assert.deepEqual(cache.get("/w/ABC-4"), { done: 2, total: 4 });
});

test("the cache uses the newest plan file and finds one that appears later", () => {
  const dir = base();
  mkdirSync(join(dir, "ABC-5"));
  const cache = createPlanCache(dir);
  assert.equal(cache.get("/w/ABC-5"), undefined);
  put(dir, "ABC-5", "plan_old.md", "## Steps\n- [ ] **1. A.**", 1000);
  put(dir, "ABC-5", "plan_new.md", PLAN, 2000);
  put(dir, "ABC-5", "notes.md", "## Steps\n- [ ] **1. A.**", 3000);
  assert.deepEqual(cache.get("/w/ABC-5"), { done: 2, total: 4 });
});
