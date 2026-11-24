import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/hook.ts";

type HookConfig = { hooks: Record<string, { hooks: { type: string; command: string }[] }[]> };

const bin = join(import.meta.dirname, "..", "bin", "bob.ts");

function bob(dir: string, ...args: string[]) {
  return spawnSync("node", [bin, ...args], { env: { ...process.env, BOB_STATE_DIR: dir }, encoding: "utf8" });
}

test("bob --once prints one frame with the sessions and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-vcli-"));
  const now = Math.floor(Date.now() / 1000);
  handle(dir, JSON.stringify({ hook_event_name: "Notification", session_id: "a", cwd: "/w/alpha", message: "Allow Bash?" }), now);
  const result = bob(dir, "--once");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /waiting/);
  assert.match(result.stdout, /alpha/);
  assert.match(result.stdout, /Allow Bash\?/);
});

test("bob --once leaves the state folder files and bob.db bytes and time unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-vcli-"));
  handle(dir, JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w/alpha" }), 100);
  const files = readdirSync(dir).sort();
  const bytes = readFileSync(join(dir, "bob.db"));
  const mtime = statSync(join(dir, "bob.db")).mtimeMs;
  const result = bob(dir, "--once");
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(dir).sort(), files);
  assert.ok(readFileSync(join(dir, "bob.db")).equals(bytes));
  assert.equal(statSync(join(dir, "bob.db")).mtimeMs, mtime);
});

test("bob --once with no database creates nothing and shows the empty line", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-vcli-"));
  const result = bob(dir, "--once");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no sessions/);
  assert.deepEqual(readdirSync(dir), []);
});

test("bob --once with a missing state folder creates nothing", () => {
  const parent = mkdtempSync(join(tmpdir(), "bob-vcli-"));
  const dir = join(parent, "absent");
  const result = bob(dir, "--once");
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(parent), []);
});

test("the hook subcommand still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-vcli-"));

  const result = spawnSync("node", [bin, "hook"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "a", cwd: "/w" }),
    env: { ...process.env, BOB_STATE_DIR: dir },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(dir), ["bob.db"]);
});

test("bob install prints JSON with the five events and edits no settings file", () => {
  const home = mkdtempSync(join(tmpdir(), "bob-home-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, '{"keep":true}');
  const before = readFileSync(settings);
  const mtime = statSync(settings).mtimeMs;
  const result = spawnSync("node", [bin, "install"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(result.status, 0);
  const parsed: HookConfig = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed.hooks).sort(), ["Notification", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);

  for (const entries of Object.values(parsed.hooks)) {
    const command = entries[0]?.hooks[0]?.command ?? "";
    assert.equal(entries[0]?.hooks[0]?.type, "command");
    assert.ok(command.includes(JSON.stringify(bin)), command);
    assert.ok(command.endsWith(" hook"), command);
  }

  assert.ok(readFileSync(settings).equals(before));
  assert.equal(statSync(settings).mtimeMs, mtime);
  assert.deepEqual(readdirSync(join(home, ".claude")), ["settings.json"]);
});
