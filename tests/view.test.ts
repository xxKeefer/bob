import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { spawnSync } from "node:child_process";
import { draw, drawUnreadable, install, main } from "../src/view.ts";
import type { Row } from "../src/rows.ts";

function row(extra: Partial<Row>): Row {
  return { sessionId: "s", cwd: "/home/u/proj", status: "idle", since: 100, updated: 100, reason: "", ...extra };
}

test("draw shows status, age, folder name, and reason", () => {
  const lines = draw([row({ status: "waiting", since: 100, cwd: "/home/u/api", reason: "Allow Bash?" })], 190, 80);
  const text = lines.join("\n");
  assert.match(text, /waiting/);
  assert.match(text, /1m30s/);
  assert.match(text, /api/);
  assert.doesNotMatch(text, /home\/u/);
  assert.match(text, /Allow Bash\?/);
});

test("draw shows one line for each row, in the order given", () => {
  const lines = draw([row({ cwd: "/a/first" }), row({ cwd: "/a/second" })], 200, 80);
  const text = lines.join("\n");
  assert.ok(text.indexOf("first") < text.indexOf("second"));
  assert.equal(lines.filter((line) => /first|second/.test(line)).length, 2);
});

test("draw shows an empty-list line when there are no rows", () => {
  const lines = draw([], 0, 80);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /no sessions/);
});

test("draw cuts each line to the width", () => {
  const lines = draw([row({ status: "waiting", reason: "x".repeat(300) })], 200, 40);

  for (const line of lines) assert.ok(line.length <= 40);

  assert.ok(lines.length > 0);
});

test("draw shows stale in place of the status and keeps the reason", () => {
  const text = draw([row({ status: "stale", reason: "Allow?" })], 9999, 80).join("\n");
  assert.match(text, /stale/);
  assert.match(text, /Allow\?/);
});

test("age formats seconds, minutes, and hours", () => {
  const age = (secs: number) => draw([row({ since: 0 })], secs, 80).join("\n");
  assert.match(age(5), /5s/);
  assert.match(age(65), /1m05s/);
  assert.match(age(3725), /1h02m/);
});

test("main redraws each interval and stops when the signal aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-view-"));
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/alpha" }), 100);
  const controller = new AbortController();
  const frames: string[] = [];
  await main({
    stateDir: dir,
    once: false,
    intervalMs: 5,
    width: 80,
    now: () => 200,
    write: (text) => {
      frames.push(text);

      if (frames.length === 3) controller.abort();
    },
    signal: controller.signal,
  });
  assert.equal(frames.length, 3);
  assert.match(frames[0] ?? "", /alpha/);
});

test("main with once writes one frame and returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-view-"));
  const frames: string[] = [];
  await main({
    stateDir: dir,
    once: true,
    intervalMs: 5,
    width: 80,
    now: () => 200,
    write: (text) => frames.push(text),
    signal: new AbortController().signal,
  });
  assert.equal(frames.length, 1);
  assert.match(frames[0] ?? "", /no sessions/);
});

test("main stops at once when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const frames: string[] = [];
  await main({
    stateDir: tmpdir(),
    once: false,
    intervalMs: 5,
    width: 80,
    now: () => 200,
    write: (text) => frames.push(text),
    signal: controller.signal,
  });
  assert.ok(frames.length <= 1);
});

test("draw strips control characters from the reason and folder name", () => {
  const text = draw([row({ cwd: "/w/al\x1bpha", reason: "\x1b[2J\x1b]52;c;x\x07done" })], 200, 200).join("\n");
  assert.doesNotMatch(text, /\p{Cc}/u);
  assert.match(text, /alpha/);
});

test("install quotes a script path that holds a space", () => {
  const parsed = JSON.parse(install("/tmp/with space/bin/bob.ts"));
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "node '/tmp/with space/bin/bob.ts' hook");
});

test("install quotes a path with a substitution, a backtick, a space and a single quote", () => {
  const script = "/tmp/a $(touch pwned) `id` it's/bob.ts";
  const command: string = JSON.parse(install(script)).hooks.Stop[0].hooks[0].command;
  assert.equal(command, `node '/tmp/a $(touch pwned) \`id\` it'\\''s/bob.ts' hook`);
  const out = spawnSync("sh", ["-c", command.replace(/^node /, "printf %s ")], { encoding: "utf8" });
  assert.equal(out.stdout, script + "hook");
});

test("draw strips controls from the status and format characters from the reason", () => {
  const text = draw([row({ status: "bu\x1b[2Jsy", reason: "a\u202Eb" })], 200, 200).join("\n");
  assert.doesNotMatch(text, /[\p{Cc}\p{Cf}]/u);
  assert.match(text, /bu\[2Jsy/);
});

test("drawUnreadable shows the cleaned message cut to the width", () => {
  assert.deepEqual(drawUnreadable("bad\x1b[2J\u202E file", 80), ["db unreadable: bad[2J file"]);
  assert.equal(drawUnreadable("x".repeat(300), 40)[0]?.length, 40);
});

test("main shows db unreadable for a corrupt database and no sessions for a missing one", async () => {
  const run = async (dir: string): Promise<string> => {
    const frames: string[] = [];
    await main({
      stateDir: dir,
      once: true,
      intervalMs: 5,
      width: 80,
      now: () => 200,
      write: (text) => frames.push(text),
      signal: new AbortController().signal,
    });

    return frames.join("");
  };

  const bad = mkdtempSync(join(tmpdir(), "bob-view-"));
  writeFileSync(join(bad, "bob.db"), "this is not a database, not at all, no sir".repeat(50));
  assert.match(await run(bad), /db unreadable: .+/);
  assert.match(await run(mkdtempSync(join(tmpdir(), "bob-view-"))), /no sessions/);
});
