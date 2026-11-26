import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

test("the zellij layout runs bob in a pane beside a shell", () => {
  const kdl = readFileSync(join(root, "layouts", "bob.kdl"), "utf8");

  assert.match(kdl, /split_direction="vertical"/);
  assert.match(kdl, /pane [^\n]*command="bob"/);
  assert.equal(kdl.match(/^\s*pane\b/gm)?.length, 3);
});

test("the README gives one command per multiplexer", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");

  assert.match(readme, /zellij --layout \S*layouts\/bob\.kdl/);
  assert.ok(readme.includes(String.raw`tmux new-session bob \; split-window -h`));
});
