import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const text = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");

test("release workflow triggers on v* tags", () => {
  assert.match(text, /on:\s*\n\s+push:\s*\n\s+tags:\s*\[\s*"v\*"\s*\]/);
});

test("release job needs checks and can write contents", () => {
  assert.match(text, /\n {2}checks:/);
  assert.match(text, /\n {2}release:[\s\S]*?needs: checks/);
  assert.match(text, /permissions:\s*\n\s+contents: write/);
});

test("checks job runs test, typecheck, and lint on Node 26", () => {
  assert.match(text, /node-version: 26/);

  for (const cmd of ["npm test", "npm run typecheck", "npm run lint"]) {
    assert.ok(text.includes(`run: ${cmd}`), cmd);
  }
});

test("release job verifies the tag against package.json", () => {
  assert.match(text, /GITHUB_REF_NAME/);
  assert.match(text, /package\.json/);
  assert.match(text, /exit 1/);
});

test("release job builds and attaches the tarball and install.sh", () => {
  assert.ok(text.includes("scripts/build-release.sh"));
  assert.match(text, /gh release create "\$GITHUB_REF_NAME" --generate-notes[^\n]*bob-[^\n]*\.tar\.gz[^\n]*install\.sh/);
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});
