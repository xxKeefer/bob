import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { main } from "../src/view.ts";
import type { RunResult } from "../src/mux.ts";
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

function jump(dir: string, run: (argv: string[]) => RunResult) {
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
  assert.deepEqual(calls.map((argv) => argv[1]), ["select-window", "select-pane", "switch-client"]);
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
