import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/hook.ts";
import { main } from "../src/view.ts";
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

function run(input: FakeInput, once = false) {
  const frames: string[] = [];

  const done = main({
    stateDir: seeded(),
    once,
    intervalMs: 60000,
    width: 80,
    now: () => 1000,
    write: (text) => frames.push(text),
    signal: new AbortController().signal,
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
  const frames: string[] = [];

  const done = main({
    stateDir: seeded(),
    once: false,
    intervalMs: 60000,
    width: 80,
    now: () => 1000,
    write: (text) => frames.push(text),
    signal: controller.signal,
    input,
  });

  assert.equal(input.listenerCount("data"), 0);
  controller.abort();
  await done;
  assert.deepEqual(input.raw, []);
  assert.equal(frames.length, 1);
  assert.ok(!frames[0]?.includes("> "));
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
