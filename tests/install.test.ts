import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as realFs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { writeSettings } from "../src/install.ts";
import type { FileSystem } from "../src/install.ts";
import { EVENTS } from "../src/hook.ts";

const COMMAND = "bob hook";
const bin = join(import.meta.dirname, "..", "bin", "bob.ts");

type Settings = {
  theme?: string;
  permissions?: { allow: string[] };
  hooks?: Record<string, { hooks: { type: string; command: string }[] }[]>;
};

function setup(content?: string) {
  const home = mkdtempSync(join(tmpdir(), "bob-install-"));
  const dir = join(home, ".claude");
  const file = join(dir, "settings.json");

  if (content !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
  }

  return { home, dir, file };
}

async function run(home: string, answer: string | undefined, fs: FileSystem = realFs, source?: Readable) {
  const out: string[] = [];
  const err: string[] = [];
  const input = source ?? Readable.from(answer === undefined ? [] : [answer]);

  const status = await writeSettings({
    home,
    command: COMMAND,
    input,
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    now: () => 1700000000123,
    fs,
  });

  return { status, out: out.join(""), err: err.join("") };
}

function backups(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("settings.json.bak-")) : [];
}

const EXISTING = JSON.stringify(
  {
    theme: "dark",
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "mine stop" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine pre" }] }],
    },
  },
  null,
  2,
);

test("y merges the five events, keeps every other key and hook, and backs up first", async () => {
  const { home, dir, file } = setup(EXISTING);
  const result = await run(home, "y\n");
  assert.equal(result.status, 0);
  assert.match(result.out, /Write to .*settings\.json\? \[y\/N\]/);
  const merged: Settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.permissions, { allow: ["Bash(ls)"] });
  assert.equal(merged.hooks?.PreToolUse?.length, 1);
  const stop = merged.hooks?.Stop ?? [];
  assert.equal(stop.length, 2);
  assert.equal(stop[0]?.hooks[0]?.command, "mine stop");

  for (const event of EVENTS) {
    const entries: NonNullable<Settings["hooks"]>[string] = merged.hooks?.[event] ?? [];
    assert.equal(entries.filter((entry) => entry.hooks.some((hook) => hook.command === COMMAND)).length, 1, event);
  }

  const [backup] = backups(dir);
  assert.equal(backups(dir).length, 1);
  assert.equal(readFileSync(join(dir, backup ?? ""), "utf8"), EXISTING);
});

test("yes in any case writes", async () => {
  for (const answer of ["yes\n", "YES\n", "Y\n", " y \n"]) {
    const { home, file } = setup(EXISTING);
    const result = await run(home, answer);
    assert.equal(result.status, 0, answer);
    assert.match(readFileSync(file, "utf8"), /bob hook/, answer);
  }
});

test("anything else, empty, or EOF edits nothing, makes no backup, exits 0", async () => {
  for (const answer of ["n\n", "\n", "maybe\n", "yy\n", "yes please\n", "", undefined]) {
    const { home, dir, file } = setup(EXISTING);
    const result = await run(home, answer);
    assert.equal(result.status, 0, String(answer));
    assert.match(result.out, /not written/, String(answer));
    assert.equal(readFileSync(file, "utf8"), EXISTING);
    assert.deepEqual(backups(dir), []);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  }
});

test("it prints the entries it will add before it asks", async () => {
  const { home } = setup(EXISTING);
  const result = await run(home, "n\n");

  for (const event of EVENTS) assert.match(result.out, new RegExp(event));
  assert.ok(result.out.indexOf("SessionEnd") < result.out.indexOf("[y/N]"));
});

test("a second run adds no duplicate and asks nothing", async () => {
  const { home, file } = setup(EXISTING);
  await run(home, "y\n");
  const once = readFileSync(file, "utf8");
  const second = await run(home, "y\n");
  assert.equal(second.status, 0);
  assert.equal(readFileSync(file, "utf8"), once);
  assert.doesNotMatch(second.out, /\[y\/N\]/);
});

test("a partial install gets only the missing events", async () => {
  const partial = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: COMMAND }] }] } });
  const { home, file } = setup(partial);
  await run(home, "y\n");
  const merged: Settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(merged.hooks?.Stop?.length, 1);
  assert.equal(merged.hooks?.SessionEnd?.length, 1);
});

test("a missing settings.json is created with its folder and needs no backup", async () => {
  const { home, dir, file } = setup();
  const result = await run(home, "y\n");
  assert.equal(result.status, 0);
  const created: Settings = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(created.hooks ?? {}).sort(), [...EVENTS].sort());
  assert.deepEqual(backups(dir), []);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("invalid JSON is left untouched with an error and exit 1", async () => {
  const { home, dir, file } = setup("{ not json");
  const result = await run(home, "y\n");
  assert.equal(result.status, 1);
  assert.notEqual(result.err, "");
  assert.equal(readFileSync(file, "utf8"), "{ not json");
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("a top-level array or a hooks value that is not an object is left untouched, exit 1", async () => {
  for (const text of ["[]", "null", '{"hooks": []}', '{"hooks": "x"}', '{"hooks": {"Stop": {}}}']) {
    const { home, dir, file } = setup(text);
    const result = await run(home, "y\n");
    assert.equal(result.status, 1, text);
    assert.notEqual(result.err, "", text);
    assert.equal(readFileSync(file, "utf8"), text);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  }
});

test("an empty or relative HOME writes nothing and exits 0", async () => {
  for (const home of ["", "rel/home"]) {
    const result = await run(home, "y\n");
    assert.equal(result.status, 0, home);
    assert.match(result.out + result.err, /not written/, home);
  }

  assert.equal(existsSync(join("rel", "home", ".claude")), false);
  assert.equal(existsSync(join(".claude", "settings.json")), false);
});

test("the write goes to a temp file in the same folder, then a rename", async () => {
  const { home, dir, file } = setup(EXISTING);
  const calls: string[] = [];

  const spy = {
    ...realFs,
    writeFileSync: (path: string, data: string) => {
      calls.push(`write ${path}`);

      return realFs.writeFileSync(path, data);
    },
    renameSync: (from: string, to: string) => {
      calls.push(`rename ${from} ${to}`);

      return realFs.renameSync(from, to);
    },
  };

  await run(home, "y\n", spy);
  const writes = calls.filter((call) => call.startsWith("write "));
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0], `write ${file}`);
  assert.ok(writes[0]?.startsWith(`write ${dir}/`));
  const [rename] = calls.filter((call) => call.startsWith("rename "));
  assert.equal(rename, `rename ${writes[0]?.slice(6)} ${file}`);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes("tmp")), []);
});

test("a symlinked settings.json stays a symlink, the target holds the merge, the backup holds the real content", async () => {
  const { home, dir, file } = setup();
  const store = join(home, "dotfiles");
  const real = join(store, "settings.json");
  mkdirSync(store, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(real, EXISTING);
  symlinkSync(real, file);
  const result = await run(home, "y\n");
  assert.equal(result.status, 0);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  const merged: Settings = JSON.parse(readFileSync(real, "utf8"));
  assert.equal(merged.theme, "dark");
  assert.equal(merged.hooks?.SessionEnd?.length, 1);
  const [backup] = backups(dir);
  assert.equal(backups(dir).length, 1);
  assert.equal(readFileSync(join(dir, backup ?? ""), "utf8"), EXISTING);
  assert.deepEqual(readdirSync(store), ["settings.json"]);
});

test("an existing 0600 settings.json stays 0600", async () => {
  const { home, file } = setup(EXISTING);
  chmodSync(file, 0o600);
  await run(home, "y\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("an existing 0640 settings.json keeps its mode", async () => {
  const { home, file } = setup(EXISTING);
  chmodSync(file, 0o640);
  await run(home, "y\n");
  assert.equal(statSync(file).mode & 0o777, 0o640);
});

test("a new settings.json is 0600 and a new .claude folder is 0700", async () => {
  const { home, dir, file } = setup();
  await run(home, "y\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("a change made to settings.json during the prompt survives the write and is backed up", async () => {
  const { home, dir, file } = setup(EXISTING);
  const changed = JSON.stringify({ ...JSON.parse(EXISTING), model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "late stop" }] }] } });

  async function* typed() {
    writeFileSync(file, changed);
    yield "y\n";
  }

  const result = await run(home, undefined, realFs, Readable.from(typed()));
  assert.equal(result.status, 0);
  const merged: Settings & { model?: string } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(merged.model, "opus");
  assert.equal(merged.hooks?.PreToolUse, undefined);
  assert.equal(merged.hooks?.Stop?.[0]?.hooks[0]?.command, "late stop");
  assert.equal(merged.hooks?.Stop?.length, 2);
  assert.equal(merged.hooks?.SessionEnd?.length, 1);
  const [backup] = backups(dir);
  assert.equal(readFileSync(join(dir, backup ?? ""), "utf8"), changed);
});

test("an existing node-form Bob hook counts as installed, gets no second entry, and is named in one note", async () => {
  const forms = ["node '/home/u/bob/bin/bob.ts' hook", "node /home/u/bob/bin/bob.ts hook"];

  for (const form of forms) {
    const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: form }] }]]));
    const text = JSON.stringify({ hooks });
    const { home, dir, file } = setup(text);
    const result = await run(home, "y\n");
    assert.equal(result.status, 0, form);
    assert.equal(readFileSync(file, "utf8"), text, form);
    assert.deepEqual(backups(dir), [], form);
    assert.doesNotMatch(result.out, /\[y\/N\]/, form);
    const notes = result.out.split("\n").filter((line) => line.includes("another form"));
    assert.equal(notes.length, 1, form);

    for (const event of EVENTS) assert.match(notes[0] ?? "", new RegExp(event), form);
  }
});

test("a node-form hook on one event leaves that event alone and adds bob hook to the rest", async () => {
  const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node '/p/bin/bob.ts' hook" }] }] } });
  const { home, file } = setup(text);
  const result = await run(home, "y\n");
  assert.match(result.out, /Stop.*another form/);
  const merged: Settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(merged.hooks?.Stop?.length, 1);
  assert.equal(merged.hooks?.Stop?.[0]?.hooks[0]?.command, "node '/p/bin/bob.ts' hook");
  assert.equal(merged.hooks?.SessionEnd?.length, 1);
});

test("hooks that merely mention bob elsewhere are not matched", async () => {
  const others = ["echo bob hook", "node /x/other.ts bob hook", "bob hook --extra", "node '/p/bin/bob.ts' hook; rm -rf x", "mybob hook"];
  const hooks = Object.fromEntries(EVENTS.map((event) => [event, others.map((command) => ({ hooks: [{ type: "command", command }] }))]));
  const { home, file } = setup(JSON.stringify({ hooks }));
  const result = await run(home, "y\n");
  assert.doesNotMatch(result.out, /another form/);
  const merged: Settings = JSON.parse(readFileSync(file, "utf8"));

  for (const event of EVENTS) assert.equal(merged.hooks?.[event]?.length, others.length + 1, event);
});

function bob(home: string, input: string, ...args: string[]) {
  return spawnSync("node", [bin, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", input });
}

test("bob install --write with piped y merges into the temp HOME", () => {
  const { home, dir, file } = setup(EXISTING);
  const result = bob(home, "y\n", "install", "--write");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[y\/N\]/);
  const merged: Settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(Object.keys(merged.hooks ?? {}).sort(), [...new Set([...EVENTS, "PreToolUse"])].sort());
  assert.equal(backups(dir).length, 1);
});

test("bob install --write with piped n edits nothing", () => {
  const { home, dir, file } = setup(EXISTING);
  const result = bob(home, "n\n", "install", "--write");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /not written/);
  assert.equal(readFileSync(file, "utf8"), EXISTING);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("bob install --write with closed stdin edits nothing", () => {
  const { home, dir, file } = setup(EXISTING);
  const result = bob(home, "", "install", "--write");
  assert.equal(result.status, 0);
  assert.equal(readFileSync(file, "utf8"), EXISTING);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("bob install with no --write still edits nothing", () => {
  const { home, dir, file } = setup(EXISTING);
  const result = bob(home, "y\n", "install");
  assert.equal(result.status, 0);
  assert.equal(readFileSync(file, "utf8"), EXISTING);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("warns before the prompt when the command is a path form", async () => {
  const { home } = setup();
  const out: string[] = [];
  const err: string[] = [];

  await writeSettings({
    home,
    command: "node '/tmp/checkout/bin/bob.ts' hook",
    input: Readable.from(["n\n"]),
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    now: () => 1700000000123,
  });

  const all = out.join("");

  assert.match(all, /warning: .*bob.* PATH/);
  assert.ok(all.indexOf("warning:") < all.indexOf("[y/N]"));
});

test("does not warn for the linked form", async () => {
  const { home } = setup();
  const result = await run(home, "n\n");

  assert.doesNotMatch(result.out, /warning:/);
});
