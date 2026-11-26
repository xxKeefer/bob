import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { markReview, readReviews } from "../src/reviews.ts";
import { loadRows } from "../src/rows.ts";

const dir = () => mkdtempSync(join(tmpdir(), "bob-reviews-"));

test("no file reads as no reviews", () => assert.deepEqual([...readReviews(dir())], []));

test("a corrupt file reads as no reviews", () => {
  const d = dir();
  writeFileSync(join(d, "reviews.json"), "{");
  assert.deepEqual([...readReviews(d)], []);
});

test("a non-array file reads as no reviews", () => {
  const d = dir();
  writeFileSync(join(d, "reviews.json"), '{"a":1}');
  assert.deepEqual([...readReviews(d)], []);
});

test("marking twice keeps one entry", () => {
  const d = dir();
  markReview(d, "/w/a");
  markReview(d, "/w/a");
  markReview(d, "/w/b");
  assert.deepEqual([...readReviews(d)].sort(), ["/w/a", "/w/b"]);
});

test("a marked folder gives a review row that sorts after ticket rows of the same status", () => {
  const d = dir();
  const send = (id: string, at: number) => handle(d, JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: "/w/" + id }), at);
  send("rev", 100);
  send("tick", 200);
  markReview(d, "/w/rev");
  const rows = loadRows(d, 300);
  assert.deepEqual(rows.map((row) => [row.sessionId, row.review]), [["tick", false], ["rev", true]]);
});

test("a waiting review still sorts before an idle ticket", () => {
  const d = dir();
  handle(d, JSON.stringify({ hook_event_name: "SessionStart", session_id: "rev", cwd: "/w/rev" }), 100);
  handle(d, JSON.stringify({ hook_event_name: "Notification", session_id: "rev", cwd: "/w/rev", message: "m" }), 100);
  handle(d, JSON.stringify({ hook_event_name: "SessionStart", session_id: "tick", cwd: "/w/tick" }), 100);
  markReview(d, "/w/rev");
  assert.deepEqual(loadRows(d, 300).map((row) => row.sessionId), ["rev", "tick"]);
});
