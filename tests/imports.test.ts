import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

function sources(): string[] {
  const files = readdirSync(join(root, "src")).map((name) => join(root, "src", name));
  files.push(join(root, "bin", "bob.ts"));

  return files;
}

test("every runtime import is a node: built-in or a relative path", () => {
  const found: string[] = [];

  for (const file of sources()) {
    const text = readFileSync(file, "utf8");

    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(match[1] ?? "");
  }

  assert.ok(found.length > 0);

  for (const spec of found) assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), spec);
});
