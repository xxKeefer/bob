import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { main } from "../src/view.ts";
import type { Capture, RunResult } from "../src/mux.ts";
import type { Input } from "../src/view.ts";

const bin = join(import.meta.dirname, "..", "bin", "bob.ts");

class FakeInput extends EventEmitter implements Input {
  isTTY: boolean;
  raw: boolean[] = [];
  paused = 0;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): this {
    this.raw.push(mode);

    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    this.paused += 1;

    return this;
  }
}

function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), "bob-keys-"));

  for (const id of ["a", "b"]) {
    handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: `/w/${id}` }), 1000);
  }

  return dir;
}

function run(input: FakeInput, once = false, signal: AbortSignal = new AbortController().signal) {
  const frames: string[] = [];

  const done = main({
    stateDir: seeded(),
    once,
    intervalMs: 60000,
    width: 80,
    now: () => 1000,
    write: (text) => frames.push(text),
    signal,
    input,
  });

  return { frames, done };
}

for (const [name, key] of [["q", "q"], ["Ctrl-C", "\u0003"]] as const) {
  test(`${name} exits and restores raw mode`, async () => {
    const input = new FakeInput(true);
    const { done } = run(input);
    input.emit("data", Buffer.from(key));
    await done;
    assert.deepEqual(input.raw, [true, false]);
    assert.equal(input.paused, 1);
    assert.equal(input.listenerCount("data"), 0);
  });
}

test("j moves the highlighted row and redraws", async () => {
  const input = new FakeInput(true);
  const { frames, done } = run(input);
  input.emit("data", Buffer.from("j"));
  input.emit("data", Buffer.from("q"));
  await done;
  const last = frames.at(-1)?.split("\n") ?? [];
  assert.ok(frames[0]?.split("\n")[1]?.startsWith("> "));
  assert.ok(last[2]?.startsWith("> "));
  assert.ok(!last[1]?.startsWith("> "));
});

test("--once reads no key and sets no raw mode", async () => {
  const input = new FakeInput(true);
  const { frames, done } = run(input, true);
  await done;
  assert.deepEqual(input.raw, []);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(frames.length, 1);
  assert.ok(!frames[0]?.includes("> "));
});

test("input that is not a terminal reads no key and sets no raw mode", async () => {
  const input = new FakeInput(false);
  const controller = new AbortController();
  const { frames, done } = run(input, false, controller.signal);
  assert.equal(input.listenerCount("data"), 0);
  controller.abort();
  await done;
  assert.deepEqual(input.raw, []);
  assert.equal(frames.length, 1);
  assert.ok(!frames[0]?.includes("> "));
});

test("an outside abort on a terminal restores raw mode and removes the listener", async () => {
  const input = new FakeInput(true);
  const controller = new AbortController();
  const { done } = run(input, false, controller.signal);
  controller.abort();
  await done;
  assert.deepEqual(input.raw, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
});

test("bob --once with piped input prints one frame, reads no key, and exits 0", () => {
  const dir = seeded();

  const result = spawnSync("node", [bin, "--once"], {
    input: "q",
    env: { ...process.env, BOB_STATE_DIR: dir },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /STATUS/);
});

test("bob with piped input ignores q and keeps running", () => {
  const dir = seeded();

  const result = spawnSync("node", [bin], {
    input: "q",
    timeout: 1500,
    env: { ...process.env, BOB_STATE_DIR: dir },
    encoding: "utf8",
  });

  assert.equal(result.signal, "SIGTERM");
  assert.match(result.stdout, /STATUS/);
});

function seededPanes(): string {
  const dir = mkdtempSync(join(tmpdir(), "bob-jump-"));
  const env = { TMUX_PANE: "%7" };
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/a" }), 1000, env, () => "s1");
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "b", cwd: "/w/b" }), 1001);

  return dir;
}

function jump(dir: string, run: (argv: string[]) => RunResult, env: Record<string, string> = {}, capture?: Capture) {
  const input = new FakeInput(true);
  const frames: string[] = [];

  const done = main({
    stateDir: dir,
    once: false,
    intervalMs: 5,
    width: 80,
    now: () => 1000,
    write: (text) => frames.push(text),
    signal: new AbortController().signal,
    input,
    run,
    env,
    capture,
  });

  return { input, frames, done };
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Enter on a row with a pane runs the focus commands and shows no error", async () => {
  const calls: string[][] = [];
  const { input, frames, done } = jump(seededPanes(), (argv) => (calls.push(argv), { ok: true }));
  input.emit("data", Buffer.from("\r"));
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls.map((argv) => argv[1]), ["switch-client", "select-window", "select-pane"]);
  assert.deepEqual(calls[0]?.slice(2), ["-t", "%7"]);
  const last = frames.at(-1) ?? "";
  assert.ok(!last.includes("no pane"));
  assert.ok(!last.includes("can't find pane"));
});

test("Enter on a row with no pane shows the message line and runs no command", async () => {
  const calls: string[][] = [];
  const { input, frames, done } = jump(seededPanes(), (argv) => (calls.push(argv), { ok: true }));
  input.emit("data", Buffer.from("j"));
  input.emit("data", Buffer.from("\r"));
  const last = frames.at(-1)?.split("\n") ?? [];
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
  assert.ok(last.some((line) => line.includes("no pane for this session")));
});

test("a failed jump shows the reason and Bob keeps refreshing", async () => {
  const { input, frames, done } = jump(seededPanes(), () => ({ ok: false, message: "can't find pane: %7" }));
  input.emit("data", Buffer.from("\r"));
  const before = frames.length;
  await sleepMs(60);
  assert.ok(frames.length > before);
  assert.ok(frames.at(-1)?.includes("can't find pane: %7"));
  input.emit("data", Buffer.from("q"));
  await done;
});

test("a failed jump message drops escape sequences and fits the width", async () => {
  const message = "x\x1b[2J" + "y".repeat(200);
  const { input, frames, done } = jump(seededPanes(), () => ({ ok: false, message }));
  input.emit("data", Buffer.from("\r"));
  const last = frames.at(-1)?.split("\n") ?? [];
  input.emit("data", Buffer.from("q"));
  await done;
  const line = last.find((candidate) => candidate.includes("x") && candidate.includes("yyy")) ?? "";

  assert.ok(line !== "" && !line.includes("\x1b") && line.length <= 80);
});

test("a jump keeps refreshing and writes no file", async () => {
  const dir = seededPanes();
  const snapshot = () => readdirSync(dir).map((name) => `${name}:${statSync(join(dir, name)).mtimeMs}:${statSync(join(dir, name)).size}`);
  const before = snapshot();
  const { input, frames, done } = jump(dir, () => ({ ok: true }));
  input.emit("data", Buffer.from("\r"));
  const count = frames.length;
  await sleepMs(60);
  assert.ok(frames.length > count);
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(snapshot(), before);
});

test("a failed jump message goes when the selection moves to another row", async () => {
  const { input, frames, done } = jump(seededPanes(), () => ({ ok: true }));
  input.emit("data", Buffer.from("j"));
  input.emit("data", Buffer.from("\r"));
  assert.ok(frames.at(-1)?.includes("no pane for this session"));
  input.emit("data", Buffer.from("k"));
  const last = frames.at(-1) ?? "";
  input.emit("data", Buffer.from("q"));
  await done;
  assert.ok(!last.includes("no pane for this session"));
});

test("a failed jump message goes after a second Enter that succeeds", async () => {
  let attempts = 0;

  const { input, frames, done } = jump(seededPanes(), () => {
    attempts += 1;

    return attempts === 1 ? { ok: false, message: "can't find pane: %7" } : { ok: true };
  });

  input.emit("data", Buffer.from("\r"));
  assert.ok(frames.at(-1)?.includes("can't find pane: %7"));
  input.emit("data", Buffer.from("\r"));
  const last = frames.at(-1) ?? "";
  input.emit("data", Buffer.from("q"));
  await done;
  assert.ok(!last.includes("can't find pane"));
});

test("the selection follows its session when a refresh changes the sort order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-follow-"));
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/a" }), 1000, { TMUX_PANE: "%7" }, () => "s1");
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "b", cwd: "/w/b" }), 1001, { TMUX_PANE: "%8" }, () => "s1");
  const calls: string[][] = [];
  const { input, frames, done } = jump(dir, (argv) => (calls.push(argv), { ok: true }));
  input.emit("data", Buffer.from("j"));
  handle(dir, JSON.stringify({ hook_event_name: "Notification", session_id: "b", cwd: "/w/b", message: "m" }), 1002);
  const count = frames.length;
  await sleepMs(60);
  assert.ok(frames.length > count);
  const marked = (frames.at(-1)?.split("\n") ?? []).filter((line) => line.startsWith("> "));
  assert.equal(marked.length, 1);
  assert.ok(marked[0]?.includes("waiting"));
  input.emit("data", Buffer.from("\r"));
  input.emit("data", Buffer.from("q"));
  await done;
  assert.equal(calls[0]?.at(-1), "%8");
});

test("Enter on a zellij row runs focus-pane-id in the stored session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-zellij-"));
  const env = { ZELLIJ_PANE_ID: "4", ZELLIJ_SESSION_NAME: "zs" };
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/a" }), 1000, env);
  const calls: string[][] = [];
  const { input, done } = jump(dir, (argv) => (calls.push(argv), { ok: true }));
  input.emit("data", Buffer.from("\r"));
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, [["zellij", "--session", "zs", "action", "focus-pane-id", "4"]]);
});

test("a failed jump message goes when a refresh drops the selected row", async () => {
  const dir = seededPanes();
  const { input, frames, done } = jump(dir, () => ({ ok: false, message: "can't find pane: %7" }));
  input.emit("data", Buffer.from("\r"));
  assert.ok(frames.at(-1)?.includes("can't find pane: %7"));
  const db = new DatabaseSync(join(dir, "bob.db"));
  db.exec("delete from sessions where session_id = 'a'");
  db.close();
  const count = frames.length;
  await sleepMs(60);
  assert.ok(frames.length > count);
  const last = frames.at(-1) ?? "";
  input.emit("data", Buffer.from("q"));
  await done;
  assert.ok(!last.includes("can't find pane"));
});

function press(keys: string[], dir: string, run: (argv: string[]) => RunResult, env: Record<string, string>) {
  const { input, frames, done } = jump(dir, run, env);

  for (const key of keys) input.emit("data", Buffer.from(key));

  const last = frames.at(-1)?.split("\n") ?? [];
  input.emit("data", Buffer.from("q"));

  return done.then(() => last);
}

test("n in tmux opens a pane in the selected folder", async () => {
  const calls: string[][] = [];
  await press(["n"], seededPanes(), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  assert.deepEqual(calls, [["tmux", "split-window", "-c", "/w/a", "claude"]]);
});

test("n in zellij opens a pane in the selected folder", async () => {
  const calls: string[][] = [];
  await press(["j", "n"], seededPanes(), (argv) => (calls.push(argv), { ok: true }), { ZELLIJ: "0" });
  assert.deepEqual(calls, [["zellij", "action", "new-pane", "--cwd", "/w/b", "--", "claude"]]);
});

test("n on a row with no folder shows the message and opens no pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-nofolder-"));
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "" }), 1000);
  const calls: string[][] = [];
  const last = await press(["n"], dir, (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  assert.deepEqual(calls, []);
  assert.ok(last.some((line) => line.includes("no folder for this row")));
});

test("n outside a multiplexer shows the message and opens no pane", async () => {
  const calls: string[][] = [];
  const last = await press(["n"], seededPanes(), (argv) => (calls.push(argv), { ok: true }), {});
  assert.deepEqual(calls, []);
  assert.ok(last.some((line) => line.includes("launch needs tmux or zellij")));
});

test("n with no rows shows no message and opens no pane", async () => {
  const calls: string[][] = [];
  const last = await press(["n"], mkdtempSync(join(tmpdir(), "bob-empty-")), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  assert.deepEqual(calls, []);
  assert.ok(last.every((line) => !line.includes("launch") && !line.includes("folder")));
});

test("a failed launch shows the error and Bob keeps refreshing", async () => {
  const { input, frames, done } = jump(seededPanes(), () => ({ ok: false, message: "no server running" }), { TMUX: "x" });
  input.emit("data", Buffer.from("n"));
  assert.ok(frames.at(-1)?.includes("no server running"));
  const count = frames.length;
  await sleepMs(60);
  assert.ok(frames.length > count);
  input.emit("data", Buffer.from("q"));
  await done;
});

test("the launch message clears after the next key", async () => {
  const last = await press(["n", "j"], seededPanes(), () => ({ ok: true }), {});
  assert.ok(!last.some((line) => line.includes("launch needs")));
});

test("N prompts for a key, Enter runs newTicket's commands, and the window opens", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "bob-cfg-"));
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ repo: "/r/app" }));
  const calls: string[][] = [];
  const capture: Capture = (argv) => ({ ok: true, stdout: argv[1] === "list" ? JSON.stringify([{ branch: "ABC-1", path: "/r/app.ABC-1" }]) : "" });
  const { input, frames, done } = jump(seededPanes(), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x", BOB_CONFIG_DIR: cfg }, capture);
  input.emit("data", Buffer.from("N"));
  input.emit("data", Buffer.from("AB"));
  input.emit("data", Buffer.from("C-1x"));
  input.emit("data", Buffer.from("\x7f"));
  assert.ok(frames.at(-1)?.includes("ticket: ABC-1"));
  input.emit("data", Buffer.from("\r"));
  await sleepMs(60);
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, [["tmux", "new-window", "-c", "/r/app.ABC-1", "claude", "/engineering:work-on ABC-1"]]);
});

test("Escape cancels the prompt and runs nothing; j is text while prompting", async () => {
  const calls: string[][] = [];
  const { input, frames, done } = jump(seededPanes(), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  input.emit("data", Buffer.from("N"));
  input.emit("data", Buffer.from("j"));
  assert.ok(frames.at(-1)?.includes("ticket: j"));
  input.emit("data", Buffer.from("\x1b"));
  assert.ok(!frames.at(-1)?.includes("ticket:"));
  input.emit("data", Buffer.from("N"));
  input.emit("data", Buffer.from("\r"));
  await sleepMs(30);
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
});

test("a bad key shows the message and runs nothing", async () => {
  const calls: string[][] = [];
  const { input, frames, done } = jump(seededPanes(), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  input.emit("data", Buffer.from("N"));
  input.emit("data", Buffer.from("bad;id\r"));
  await sleepMs(60);
  const last = frames.at(-1) ?? "";
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
  assert.ok(last.includes("ticket key"));
});

test("n still opens a pane beside the selected row", async () => {
  const calls: string[][] = [];
  await press(["n"], seededPanes(), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  assert.deepEqual(calls, [["tmux", "split-window", "-c", "/w/a", "claude"]]);
});

test("bob new with a bad key exits 1 and names the problem", () => {
  const result = spawnSync("node", [bin, "new", "bad;id"], { encoding: "utf8", env: { ...process.env, BOB_CONFIG_DIR: "/nonexistent-bob" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ticket key/);
});

test("bob new with no config exits 1", () => {
  const result = spawnSync("node", [bin, "new", "ABC-1"], { encoding: "utf8", env: { ...process.env, BOB_CONFIG_DIR: "/nonexistent-bob" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config/);
});

function cleanRun(prState: string, calls: string[][], captured: string[][]) {
  const cfg = mkdtempSync(join(tmpdir(), "bob-cfg-"));
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ repo: "/r/app" }));
  const dir = seededPanes();
  const input = new FakeInput(true);
  const frames: string[] = [];

  const exec = async (argv: string[]) =>
    argv[0] === "git" ? { ok: true as const, stdout: "feat/x\n" } : { ok: true as const, stdout: JSON.stringify({ state: prState, isDraft: false }) };

  const capture: Capture = (argv) => (captured.push(argv), { ok: true, stdout: argv[0] === "git" ? "feat/x\n" : JSON.stringify({ state: prState, isDraft: false }) });

  const done = main({
    stateDir: dir,
    once: false,
    intervalMs: 5,
    width: 100,
    now: () => 1000,
    write: (text) => frames.push(text),
    signal: new AbortController().signal,
    input,
    run: (argv) => (calls.push(argv), { ok: true }),
    env: { TMUX: "x", BOB_CONFIG_DIR: cfg },
    capture,
    exec,
  });

  return { input, frames, done, dir };
}

function rowCount(dir: string): number {
  const db = new DatabaseSync(join(dir, "bob.db"));
  const count = Number(db.prepare("select count(*) as n from sessions").get()?.n);
  db.close();

  return count;
}

test("x on a merged row asks, and y removes the worktree, closes the window, and drops the row", async () => {
  const calls: string[][] = [];
  const captured: string[][] = [];
  const { input, frames, done, dir } = cleanRun("MERGED", calls, captured);
  await sleepMs(60);
  input.emit("data", Buffer.from("x"));
  assert.ok(frames.at(-1)?.includes("y/N"));
  input.emit("data", Buffer.from("y"));
  await sleepMs(60);
  input.emit("data", Buffer.from("q"));
  await done;
  assert.ok(captured.some((argv) => argv.join(" ") === "wt remove feat/x"));
  assert.deepEqual(calls, [["tmux", "kill-window", "-t", "%7"]]);
  assert.equal(rowCount(dir), 1);
});

test("x then anything but y cancels and runs nothing", async () => {
  const calls: string[][] = [];
  const captured: string[][] = [];
  const { input, frames, done, dir } = cleanRun("MERGED", calls, captured);
  await sleepMs(60);
  input.emit("data", Buffer.from("x"));
  input.emit("data", Buffer.from("n"));
  assert.ok(!frames.at(-1)?.includes("y/N"));
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
  assert.deepEqual(captured, []);
  assert.equal(rowCount(dir), 2);
});

test("x on a row whose PR is not merged is refused and asks nothing", async () => {
  const calls: string[][] = [];
  const captured: string[][] = [];
  const { input, frames, done, dir } = cleanRun("OPEN", calls, captured);
  await sleepMs(60);
  input.emit("data", Buffer.from("x"));
  assert.ok(frames.at(-1)?.includes("not merged"));
  assert.ok(!frames.at(-1)?.includes("y/N"));
  input.emit("data", Buffer.from("y"));
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
  assert.deepEqual(captured, []);
  assert.equal(rowCount(dir), 2);
});

test("v prompts for a PR number, Enter opens the review window, and the folder is marked", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "bob-cfg-"));
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ repo: "/r/app" }));
  const calls: string[][] = [];

  const capture: Capture = (argv) => {
    if (argv[0] === "gh") return { ok: true, stdout: JSON.stringify({ headRefName: "feat/x" }) };

    return { ok: true, stdout: argv[1] === "list" ? JSON.stringify([{ branch: "feat/x", path: "/r/app.x" }]) : "" };
  };

  const dir = seededPanes();
  const { input, frames, done } = jump(dir, (argv) => (calls.push(argv), { ok: true }), { TMUX: "x", BOB_CONFIG_DIR: cfg }, capture);
  input.emit("data", Buffer.from("v"));
  input.emit("data", Buffer.from("27"));
  assert.ok(frames.at(-1)?.includes("review PR: 27"));
  input.emit("data", Buffer.from("\r"));
  await sleepMs(60);
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, [["tmux", "new-window", "-c", "/r/app.x", "claude", "/engineering:review-pr 27"]]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "reviews.json"), "utf8")), ["/r/app.x"]);
});

test("a bad PR number shows the message and runs nothing", async () => {
  const calls: string[][] = [];
  const { input, frames, done } = jump(seededPanes(), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  input.emit("data", Buffer.from("v"));
  input.emit("data", Buffer.from("1;id\r"));
  await sleepMs(60);
  const last = frames.at(-1) ?? "";
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
  assert.ok(last.includes("PR number"));
});

function stuckDir(env: Record<string, string>, mtime: number): string {
  const dir = mkdtempSync(join(tmpdir(), "bob-stuck-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, "{}\n");
  utimesSync(file, mtime, mtime);
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/w/a", transcript_path: file };
  handle(dir, JSON.stringify(payload), 900, env, () => "s1");

  return dir;
}

async function pressSettled(keys: string[], dir: string, run: (argv: string[]) => RunResult, env: Record<string, string>) {
  const { input, frames, done } = jump(dir, run, env);

  for (const key of keys) input.emit("data", Buffer.from(key));

  await sleepMs(60);
  const last = frames.at(-1)?.split("\n") ?? [];
  input.emit("data", Buffer.from("q"));
  await done;

  return last;
}

test("r on a stuck tmux row respawns the pane with claude --continue", async () => {
  const calls: string[][] = [];
  const last = await pressSettled(["r"], stuckDir({ TMUX_PANE: "%7" }, 100), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  assert.ok(last.join("\n").includes("stuck"));
  assert.deepEqual(calls, [["tmux", "respawn-pane", "-k", "-t", "%7", "-c", "/w/a", "claude", "--continue"]]);
});

test("r on a row that is not stuck shows a message and runs nothing", async () => {
  const calls: string[][] = [];
  const last = await pressSettled(["r"], stuckDir({ TMUX_PANE: "%7" }, 900), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x" });
  assert.deepEqual(calls, []);
  assert.ok(last.join("\n").includes("not stuck"));
});

test("r on a stuck zellij row shows the not supported message and runs nothing", async () => {
  const calls: string[][] = [];
  const env = { ZELLIJ_PANE_ID: "4", ZELLIJ_SESSION_NAME: "zs" };
  const last = await pressSettled(["r"], stuckDir(env, 100), (argv) => (calls.push(argv), { ok: true }), { ZELLIJ: "0" });
  assert.deepEqual(calls, []);
  assert.ok(last.join("\n").includes("not supported in zellij"));
});

test("the configured stuckSeconds decides when a busy row is stuck", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "bob-cfg-"));
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ stuckSeconds: 5000 }));
  const calls: string[][] = [];
  const { input, frames, done } = jump(stuckDir({ TMUX_PANE: "%7" }, 100), (argv) => (calls.push(argv), { ok: true }), { TMUX: "x", BOB_CONFIG_DIR: cfg });
  await sleepMs(60);
  input.emit("data", Buffer.from("r"));
  await sleepMs(30);
  const last = frames.at(-1)?.split("\n") ?? [];
  input.emit("data", Buffer.from("q"));
  await done;
  assert.deepEqual(calls, []);
  assert.ok(last.join("\n").includes("not stuck"));
});
