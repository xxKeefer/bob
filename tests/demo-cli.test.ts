import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "bob.ts");

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "bob-demo-home-"));
  const temp = mkdtempSync(join(tmpdir(), "bob-demo-tmp-"));
  const env = { ...process.env, HOME: home, TMPDIR: temp, BOB_STATE_DIR: undefined };

  return { home, temp, env };
}

test("bob demo --once prints five fake sessions in each status and removes its temp folder", () => {
  const { home, temp, env } = sandbox();
  const result = spawnSync("node", [bin, "demo", "--once"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [heading, ...lines] = result.stdout.trim().split("\n");
  assert.match(heading ?? "", /^STATUS/);
  assert.equal(lines.length, 5);
  assert.equal(lines.filter((line) => line.startsWith("waiting")).length, 2);
  assert.equal(lines.filter((line) => line.startsWith("busy")).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("idle")).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("stale")).length, 1);
  assert.ok(lines[0]?.startsWith("waiting") && lines[1]?.startsWith("waiting"));
  assert.notEqual(lines[0]?.split(/\s{2,}/)[3], lines[1]?.split(/\s{2,}/)[3]);
  assert.deepEqual(readdirSync(temp), []);
  assert.deepEqual(readdirSync(home), []);
});

test("bob -d is the same as bob demo", () => {
  const { env } = sandbox();
  const short = spawnSync("node", [bin, "-d", "--once"], { env, encoding: "utf8" });
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /api-server/);
  assert.equal(short.stdout.trim().split("\n").length, 6);
});

test("bob demo on Ctrl-C removes its temp folder and touches neither state nor claude folder", async () => {
  const { home, temp, env } = sandbox();
  const child = spawn("node", [bin, "demo"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let seen = "";
  child.stdout.on("data", (chunk) => (seen += chunk));

  const deadline = Date.now() + 10000;

  while (!seen.includes("waiting") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

  assert.match(seen, /waiting/);

  assert.equal(readdirSync(temp).length, 1);
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.kill("SIGINT");
  assert.equal(await closed, 0);
  assert.deepEqual(readdirSync(temp), []);
  assert.deepEqual(readdirSync(home), []);
});
