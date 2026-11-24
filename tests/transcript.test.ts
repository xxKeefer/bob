import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readUsage } from "../src/transcript.ts";

function entry(model: string, input: number, created: number, read: number): string {
  const usage = { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: 999 };

  return JSON.stringify({ type: "assistant", message: { model, usage } });
}

function transcript(lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "bob-transcript-")), "t.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");

  return file;
}

test("readUsage sums input and cache tokens of the last assistant entry and gives its model", () => {
  const file = transcript([entry("claude-opus-5-5", 1, 2, 3), JSON.stringify({ type: "user" }), entry("claude-sonnet-5-5", 10, 200, 3000)]);
  assert.deepEqual(readUsage(file), { tokens: 3210, model: "claude-sonnet-5-5" });
});

test("readUsage skips synthetic entries and lines that are not JSON", () => {
  const file = transcript([entry("claude-opus-5-5", 5, 5, 5), entry("<synthetic>", 0, 0, 0), "{not json"]);
  assert.deepEqual(readUsage(file), { tokens: 15, model: "claude-opus-5-5" });
});

test("readUsage returns undefined for no path, a missing file, a folder, and a file with no usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-transcript-"));
  mkdirSync(join(dir, "sub"));
  assert.equal(readUsage(""), undefined);
  assert.equal(readUsage(join(dir, "nope.jsonl")), undefined);
  assert.equal(readUsage(join(dir, "sub")), undefined);
  assert.equal(readUsage(transcript([JSON.stringify({ type: "user" })])), undefined);
});

test("readUsage reads only the end of a large file and survives a cut first line", () => {
  const filler = JSON.stringify({ type: "user", text: "x".repeat(1000) });
  const file = transcript([...Array.from({ length: 2000 }, () => filler), entry("claude-haiku-5-5", 1, 1, 1)]);
  assert.deepEqual(readUsage(file), { tokens: 3, model: "claude-haiku-5-5" });
});
