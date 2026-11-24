import * as nodeFs from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { EVENTS } from "./hook.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type JsonObject = Record<string, Json>;

export interface FileSystem {
  readFileSync: (path: string, encoding: "utf8") => string;
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => void;
  copyFileSync: (from: string, to: string) => void;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
  realpathSync: (path: string) => string;
  statSync: (path: string) => { mode: number };
  chmodSync: (path: string, mode: number) => void;
}

export interface WriteOptions {
  home: string | undefined;
  command: string;
  input: Readable;
  write: (text: string) => void;
  writeError: (text: string) => void;
  now: () => number;
  fs?: FileSystem;
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== undefined && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

const BOB_FORM = /^(?:bob hook|node (?:'(?:[^']|'\\'')*bin\/bob\.ts'|[^\s']*bin\/bob\.ts) hook)$/;

function commandsOf(entries: Json[]): string[] {
  return entries.flatMap((entry) =>
    isObject(entry) && Array.isArray(entry.hooks)
      ? entry.hooks.flatMap((hook) => (isObject(hook) && hook.command !== undefined ? [String(hook.command)] : []))
      : [],
  );
}

function hasCommand(entries: Json[], command: string): boolean {
  return commandsOf(entries).some((existing) => existing === command || (BOB_FORM.test(command) && BOB_FORM.test(existing)));
}

function hasOtherForm(entries: Json[], command: string): boolean {
  return !commandsOf(entries).includes(command) && hasCommand(entries, command);
}

function ask(input: Readable): Promise<string> {
  return new Promise((resolve) => {
    const lines = createInterface({ input });
    let answered = false;

    lines.once("line", (line) => {
      answered = true;
      lines.close();
      resolve(line);
    });
    lines.once("close", () => {
      if (!answered) resolve("");
    });
  });
}

function isMissing(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

interface Loaded {
  error: string | undefined;
  settings: JsonObject;
  hooks: JsonObject;
  exists: boolean;
}

function load(fs: FileSystem, file: string): Loaded {
  let settings: JsonObject = {};
  let exists = true;

  try {
    const parsed: Json = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!isObject(parsed)) throw new Error("top level is not an object");

    settings = parsed;
  } catch (error) {
    if (!(error instanceof Error) || !isMissing(error)) {
      const reason = error instanceof Error ? error.message : "unreadable";

      return { error: `error: cannot use ${file}: ${reason}\n`, settings, hooks: {}, exists };
    }

    exists = false;
  }

  const hooks = settings.hooks ?? {};

  if (!isObject(hooks)) return { error: `error: ${file}: "hooks" is not an object\n`, settings, hooks: {}, exists };

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      return { error: `error: ${file}: hooks.${event} is not an array\n`, settings, hooks, exists };
    }
  }

  return { error: undefined, settings, hooks, exists };
}

function entriesOf(hooks: JsonObject, event: string): Json[] {
  const entries = hooks[event];

  return Array.isArray(entries) ? entries : [];
}

export async function writeSettings(options: WriteOptions): Promise<number> {
  const fs = options.fs ?? nodeFs;
  const { home, command } = options;

  if (home === undefined || home === "" || !isAbsolute(home)) {
    options.write("not written: HOME is not an absolute path\n");

    return 0;
  }

  const file = join(home, ".claude", "settings.json");
  const first = load(fs, file);

  if (first.error !== undefined) {
    options.writeError(first.error);

    return 1;
  }

  const missingEvents = EVENTS.filter((event) => !hasCommand(entriesOf(first.hooks, event), command));

  const otherForm = EVENTS.filter((event) => hasOtherForm(entriesOf(first.hooks, event), command));

  if (otherForm.length > 0) {
    options.write(`note: ${otherForm.join(", ")}: a Bob hook in another form exists, left as is\n`);
  }

  if (missingEvents.length === 0) {
    options.write(`already installed in ${file}\n`);

    return 0;
  }

  const entry: Json = { hooks: [{ type: "command", command }] };

  options.write(JSON.stringify({ hooks: Object.fromEntries(missingEvents.map((event) => [event, [entry]])) }, null, 2) + "\n");

  if (command !== "bob hook") {
    options.write("warning: no bob link on PATH, so this hook points into the checkout. Moving or deleting the checkout makes every hook exit 1. Link first: ln -s <checkout>/bin/bob.ts ~/.local/bin/bob\n");
  }

  options.write(`Write to ${file}? [y/N] `);

  const answer = (await ask(options.input)).trim().toLowerCase();

  if (answer !== "y" && answer !== "yes") {
    options.write("\nnot written\n");

    return 0;
  }

  const current = load(fs, file);

  if (current.error !== undefined) {
    options.writeError(current.error);

    return 1;
  }

  const { settings, hooks, exists } = current;
  const stillMissing = EVENTS.filter((event) => !hasCommand(entriesOf(hooks, event), command));

  if (stillMissing.length === 0) {
    options.write(`already installed in ${file}\n`);

    return 0;
  }

  const merged = { ...hooks };

  for (const event of stillMissing) merged[event] = [...entriesOf(hooks, event), entry];

  const next = JSON.stringify({ ...settings, hooks: merged }, null, 2) + "\n";
  const target = exists ? fs.realpathSync(file) : file;
  const dir = dirname(target);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (exists) fs.copyFileSync(target, `${file}.bak-${options.now()}`);

  const temp = join(dir, `.settings.json.tmp-${process.pid}-${options.now()}`);

  const mode = exists ? fs.statSync(target).mode & 0o777 : 0o600;

  fs.writeFileSync(temp, next);
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
  options.write(`written ${file}\n`);

  return 0;
}
