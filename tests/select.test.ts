import assert from "node:assert/strict";
import { test } from "node:test";
import { move, reconcile, START } from "../src/select.ts";
import { parseKeys } from "../src/keys.ts";
import { draw } from "../src/view.ts";
import type { Row } from "../src/rows.ts";

const IDS = ["a", "b", "c"];

function row(sessionId: string): Row {
  return { sessionId, cwd: `/w/${sessionId}`, status: "idle", since: 100, updated: 100, reason: "", context: undefined };
}

test("the first row is selected at start", () => {
  assert.deepEqual(reconcile(START, IDS), { id: "a", index: 0 });
});

test("no rows leave no selection", () => {
  assert.deepEqual(reconcile(START, []), { id: undefined, index: 0 });
});

test("down moves to the next row and up moves back", () => {
  const down = move(reconcile(START, IDS), IDS, 1);
  assert.deepEqual(down, { id: "b", index: 1 });
  assert.deepEqual(move(down, IDS, -1), { id: "a", index: 0 });
});

test("the selection stops at the first and last row", () => {
  assert.deepEqual(move(reconcile(START, IDS), IDS, -1), { id: "a", index: 0 });
  const last = move(move(reconcile(START, IDS), IDS, 1), IDS, 1);
  assert.deepEqual(last, { id: "c", index: 2 });
  assert.deepEqual(move(last, IDS, 1), { id: "c", index: 2 });
});

test("a re-sort keeps the selection on the same session", () => {
  const selected = move(reconcile(START, IDS), IDS, 1);
  assert.deepEqual(reconcile(selected, ["c", "a", "b"]), { id: "b", index: 2 });
});

test("when the selected session leaves, the selection moves to the nearest row", () => {
  const selected = move(reconcile(START, IDS), IDS, 1);
  assert.deepEqual(reconcile(selected, ["a", "c"]), { id: "c", index: 1 });
  const last = move(selected, IDS, 1);
  assert.deepEqual(reconcile(last, ["a", "b"]), { id: "b", index: 1 });
  assert.deepEqual(reconcile(last, []), { id: undefined, index: 0 });
});

test("draw marks only the selected row", () => {
  const lines = draw(IDS.map(row), 200, 80, false, 1);
  assert.equal(lines.filter((line) => line.startsWith("> ")).length, 1);
  assert.ok(lines[2]?.startsWith("> "));
  assert.ok(lines.every((line) => line.length <= 80));
});

test("draw with color highlights the selected row", () => {
  const lines = draw(IDS.map(row), 200, 80, true, 0);
  assert.ok(lines[1]?.includes("\u001b[7m"));
  assert.ok(!lines[2]?.includes("\u001b[7m"));
});

test("draw with no selection adds no marker", () => {
  assert.ok(draw(IDS.map(row), 200, 80).every((line) => !line.startsWith("> ")));
});

test("parseKeys reads the move and quit keys", () => {
  assert.deepEqual(parseKeys("j"), ["down"]);
  assert.deepEqual(parseKeys("\u001b[B"), ["down"]);
  assert.deepEqual(parseKeys("k"), ["up"]);
  assert.deepEqual(parseKeys("\u001b[A"), ["up"]);
  assert.deepEqual(parseKeys("q"), ["quit"]);
  assert.deepEqual(parseKeys("\u0003"), ["quit"]);
  assert.deepEqual(parseKeys("jjx\r"), ["down", "down"]);
});
