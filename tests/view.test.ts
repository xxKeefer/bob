import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { spawnSync } from "node:child_process";
import { draw, drawUnreadable, install, isLinked, main } from "../src/view.ts";
import type { Row } from "../src/rows.ts";

function row(extra: Partial<Row>): Row {
  return { sessionId: "s", cwd: "/home/u/proj", status: "idle", since: 100, updated: 100, reason: "", context: undefined, multiplexer: "", muxSession: "", paneId: "", ...extra };
}

test("draw shows status, age, folder name, and reason", () => {
  const lines = draw([row({ status: "waiting", since: 100, cwd: "/home/u/api", reason: "Allow Bash?" })], 190, 120);
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

test("draw puts a heading line above the rows, aligned with the columns", () => {
  const [heading, line] = draw([row({ status: "waiting", since: 100, cwd: "/a/api", reason: "Allow?" })], 190, 120);
  assert.match(heading ?? "", /^STATUS +AGE +CONTEXT +MODEL +FOLDER +REASON$/);
  assert.equal(heading?.indexOf("FOLDER"), line?.indexOf("api"));
  assert.equal(heading?.indexOf("REASON"), line?.indexOf("Allow?"));
});

const ESC = "\u001b";

function withContext(tokens: number, model = "claude-opus-5-5"): Partial<Row> {
  return { context: { tokens, model } };
}

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

test("draw with color keeps the text of the plain draw and cuts to the width", () => {
  const rows = [
    row({ status: "waiting", cwd: "/a/api", reason: "Allow?" }),
    row({ status: "busy" }),
    row({ status: "idle" }),
    row({ status: "stale", reason: "x".repeat(300) }),
  ];

  for (const width of [200, 40, 5]) {
    const plain = draw(rows, 190, width);
    const colored = draw(rows, 190, width, true);
    assert.deepEqual(colored.map((line) => line.replace(SGR, "")), plain);
  }
});

test("draw with color paints each status in its own color and dims the age", () => {
  const [heading, waiting, busy, idle, stale] = draw(
    [row({ status: "waiting", reason: "Allow?" }), row({ status: "busy" }), row({ status: "idle" }), row({ status: "stale" })],
    190,
    80,
    true,
  );

  assert.ok(heading?.startsWith(`${ESC}[2mSTATUS`));
  assert.ok(waiting?.startsWith(`${ESC}[1;33m\u25c6 waiting`));
  assert.ok(waiting?.includes(`${ESC}[33mAllow?`));
  assert.ok(busy?.startsWith(`${ESC}[32m\u25cf busy`));
  assert.ok(idle?.startsWith(`${ESC}[36m\u25cb idle`));
  assert.ok(stale?.startsWith(`${ESC}[2m\u25cc stale`));
  assert.ok(busy?.includes(`${ESC}[2m  1m30s${ESC}[0m`));
});

test("draw shows an icon before each status", () => {
  const [, waiting, busy, idle, stale] = draw(
    [row({ status: "waiting" }), row({ status: "busy" }), row({ status: "idle" }), row({ status: "stale" })],
    190,
    80,
  );

  assert.ok(waiting?.startsWith("\u25c6 waiting"));
  assert.ok(busy?.startsWith("\u25cf busy"));
  assert.ok(idle?.startsWith("\u25cb idle"));
  assert.ok(stale?.startsWith("\u25cc stale"));
});

test("draw shows the context as a bar and a percent of 300k tokens, and the short model name", () => {
  const [heading, line] = draw([row(withContext(75000, "claude-sonnet-5-5-20260101"))], 190, 120);
  assert.match(line ?? "", /\u2588\u2588\u2591{6} +25% +sonnet-5-5 /);
  assert.equal(heading?.indexOf("CONTEXT"), line?.indexOf("\u2588"));
  assert.equal(heading?.indexOf("MODEL"), line?.indexOf("sonnet"));
});

test("draw rounds the bar, fills it at 300k tokens, and keeps counting the percent past 300k", () => {
  const at = (tokens: number) => draw([row(withContext(tokens))], 190, 120)[1] ?? "";
  assert.match(at(0), /\u2591{8} +0%/);
  assert.match(at(140000), /\u2588{4}\u2591{4} +46%/);
  assert.match(at(300000), /\u2588{8} +100%/);
  assert.match(at(450000), /\u2588{8} +150%/);
});

test("draw leaves the context and model cells blank when the row has no context", () => {
  const [heading, line] = draw([row({ cwd: "/a/api", reason: "r" })], 190, 120);
  assert.equal(heading?.indexOf("FOLDER"), line?.indexOf("api"));
  assert.doesNotMatch(line ?? "", /%|\u2588|\u2591/);
});

test("draw strips controls from the model name", () => {
  const line = draw([row(withContext(1, "claude-x\u001b[2Jy"))], 190, 120)[1] ?? "";
  assert.ok(!line.includes(ESC));
});

test("draw with color paints the bar by tokens and the empty cells dim", () => {
  const at = (tokens: number) => draw([row(withContext(tokens))], 190, 120, true)[1] ?? "";
  assert.ok(at(75000).includes(`${ESC}[32m\u2588\u2588${ESC}[0m${ESC}[2m\u2591\u2591\u2591\u2591\u2591\u2591${ESC}[0m`));
  assert.ok(at(75000).includes(`${ESC}[32m 25%${ESC}[0m`));
  assert.ok(at(99999).includes(`${ESC}[32m`));
  assert.ok(at(100000).includes(`${ESC}[33m`));
  assert.ok(at(200000).includes(`${ESC}[38;5;208m`));
  assert.ok(at(300000).includes(`${ESC}[31m`));
});

test("draw without color writes no escape code", () => {
  assert.ok(!draw([row({ status: "waiting" })], 190, 80).join("\n").includes(ESC));
});

test("main with color writes colored rows and with no color writes none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-view-"));
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/alpha" }), 100);
  const frames: string[] = [];

  for (const color of [true, false]) {
    await main({
      stateDir: dir,
      once: true,
      intervalMs: 5,
      width: 80,
      now: () => 200,
      color,
      write: (text) => frames.push(text),
      signal: new AbortController().signal,
    });
  }

  assert.ok(frames[0]?.includes(`${ESC}[36m\u25cb idle`));
  assert.ok(!frames[1]?.includes(ESC));
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
  const text = draw([row({ cwd: "/w/al\x1bpha", reason: "\x1b[2J\x1b]52;c;x\x07done" })], 200, 200).at(-1) ?? "";
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
  const text = draw([row({ status: "bu\x1b[2Jsy", reason: "a\u202Eb" })], 200, 200).at(-1) ?? "";
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

test("draw turns a run of newline, carriage return and tab in the reason into one space", () => {
  const text = draw([row({ reason: "needs\nyour\r\n\tpermission" })], 200, 200).at(-1) ?? "";
  assert.match(text, /needs your permission$/);
  assert.doesNotMatch(text, /\p{Cc}/u);
});

test("draw cuts the cleaned reason to the width", () => {
  const [, line] = draw([row({ reason: `ab\ncdef${"x".repeat(200)}` })], 200, 74);
  assert.equal(line?.length, 74);
  assert.ok(line?.includes("ab cdefxxx"));
});

test("drawUnreadable turns a newline into a space", () => {
  assert.deepEqual(drawUnreadable("bad\nfile", 80), ["db unreadable: bad file"]);
});

function pathFixture() {
  const root = mkdtempSync(join(tmpdir(), "bob-linked-"));
  const script = join(root, "real-bob.ts");
  writeFileSync(script, "");
  chmodSync(script, 0o755);
  const ours = join(root, "ours");
  const foreign = join(root, "foreign");
  mkdirSync(ours);
  mkdirSync(foreign);
  symlinkSync(script, join(ours, "bob"));
  writeFileSync(join(foreign, "bob"), "");
  chmodSync(join(foreign, "bob"), 0o755);

  return { script, ours, foreign };
}

test("isLinked is false when a foreign bob comes first on the PATH", () => {
  const { script, ours, foreign } = pathFixture();
  assert.equal(isLinked(script, [foreign, ours].join(delimiter)), false);
});

test("isLinked is true when our bob comes first on the PATH", () => {
  const { script, ours, foreign } = pathFixture();
  assert.equal(isLinked(script, [ours, foreign].join(delimiter)), true);
});

test("isLinked skips empty and relative entries and non-executable bobs", () => {
  const { script, ours, foreign } = pathFixture();
  chmodSync(join(foreign, "bob"), 0o644);
  assert.equal(isLinked(script, ["", "rel/dir", foreign, ours].join(delimiter)), true);
});

const NARROW_ROWS = [
  row({ status: "waiting", since: 100, cwd: "/a/my-long-project-name", reason: "Allow Bash to run the migration script?", ...withContext(150000, "claude-opus-5-5") }),
  row({ status: "busy", cwd: "/a/other", ...withContext(1000) }),
  row({ status: "idle", cwd: "/a/third" }),
];

test("draw at 80 columns shows the status, the folder, and the start of the reason", () => {
  const [heading, waiting] = draw(NARROW_ROWS, 190, 80);
  assert.ok(waiting !== undefined && waiting.length <= 80);
  assert.match(waiting, /waiting/);
  assert.match(waiting, /my-long-project-name/);
  assert.match(waiting, /Allow Bash to run/);
  assert.doesNotMatch(heading ?? "", /MODEL/);
});

test("draw at 120 columns keeps the model column", () => {
  const [heading, waiting] = draw(NARROW_ROWS, 190, 120);
  assert.match(heading ?? "", /^STATUS +AGE +CONTEXT +MODEL +FOLDER +REASON$/);
  assert.match(waiting ?? "", /opus-5-5/);
  assert.equal(heading?.indexOf("REASON"), 70);
});

test("draw at 100 columns shows at least 20 characters of the reason", () => {
  const [, waiting] = draw(NARROW_ROWS, 190, 100);
  assert.match(waiting ?? "", /Allow Bash to run the m/);
});

test("draw at 60 columns shrinks the folder and still shows the reason start", () => {
  const [heading, waiting] = draw(NARROW_ROWS, 190, 60);
  assert.match(waiting ?? "", /Allow/);
  assert.doesNotMatch(heading ?? "", /MODEL/);
});

test("draw aligns the heading with the rows at every width, with and without color", () => {
  for (const width of [60, 70, 80, 90, 100, 119, 120, 160]) {
    for (const color of [false, true]) {
      const [heading, waiting] = draw(NARROW_ROWS, 190, width, color).map((line) => line.replace(SGR, ""));
      assert.equal(heading?.indexOf("FOLDER"), waiting?.indexOf("my-"), `folder at ${width}`);
      assert.equal(heading?.indexOf("REASON"), waiting?.indexOf("Allow"), `reason at ${width}`);
    }
  }
});

test("draw at 80 columns paints the reason of a waiting row from its start", () => {
  const [, waiting] = draw(NARROW_ROWS, 190, 80, true);
  assert.ok(waiting?.includes(`${ESC}[33mAllow`));
});
