import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

test("node:sqlite opens an in-memory database", () => {
  const db = new DatabaseSync(":memory:");
  const row = db.prepare("select 1 as one").get();
  db.close();
  assert.equal(row?.one, 1);
});
