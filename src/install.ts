import * as nodeFs from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { EVENTS } from "./hook.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type JsonObject = Record<string, Json>;

export interface FileSystem {
  readFileSync: (path: string, encoding: "utf8") => string;
  mkdirSync: (path: string, options: { recursive: true }) => void;
  copyFileSync: (from: string, to: string) => void;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
  realpathSync: (path: string) => string;
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

function hasCommand(entries: Json[], command: string): boolean {
  return entries.some(
    (entry) =>
      isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => isObject(hook) && hook.command === command),
  );
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

export async function writeSettings(options: WriteOptions): Promise<number> {
  const fs = options.fs ?? nodeFs;
  const { home, command } = options;

  if (home === undefined || home === "" || !isAbsolute(home)) {
    options.write("not written: HOME is not an absolute path\n");

    return 0;
  }

  const file = join(home, ".claude", "settings.json");
  let settings: JsonObject = {};
  let exists = true;

  try {
    const parsed: Json = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!isObject(parsed)) throw new Error("top level is not an object");

    settings = parsed;
  } catch (error) {
    if (!(error instanceof Error) || !isMissing(error)) {
      options.writeError(`error: cannot use ${file}: ${error instanceof Error ? error.message : "unreadable"}\n`);

      return 1;
    }

    exists = false;
  }

  const hooks = settings.hooks ?? {};

  if (!isObject(hooks)) {
    options.writeError(`error: ${file}: "hooks" is not an object\n`);

    return 1;
  }

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      options.writeError(`error: ${file}: hooks.${event} is not an array\n`);

      return 1;
    }
  }

  const entriesOf = (event: string): Json[] => {
    const entries = hooks[event];

    return Array.isArray(entries) ? entries : [];
  };

  const missingEvents = EVENTS.filter((event) => !hasCommand(entriesOf(event), command));

  if (missingEvents.length === 0) {
    options.write(`already installed in ${file}\n`);

    return 0;
  }

  const entry: Json = { hooks: [{ type: "command", command }] };

  options.write(JSON.stringify({ hooks: Object.fromEntries(missingEvents.map((event) => [event, [entry]])) }, null, 2) + "\n");
  options.write(`Write to ${file}? [y/N] `);

  const answer = (await ask(options.input)).trim().toLowerCase();

  if (answer !== "y" && answer !== "yes") {
    options.write("\nnot written\n");

    return 0;
  }

  const merged = { ...hooks };

  for (const event of missingEvents) merged[event] = [...entriesOf(event), entry];

  const next = JSON.stringify({ ...settings, hooks: merged }, null, 2) + "\n";
  const target = exists ? fs.realpathSync(file) : file;
  const dir = dirname(target);

  fs.mkdirSync(dir, { recursive: true });

  if (exists) fs.copyFileSync(target, `${file}.bak-${options.now()}`);

  const temp = join(dir, `.settings.json.tmp-${process.pid}-${options.now()}`);

  fs.writeFileSync(temp, next);
  fs.renameSync(temp, target);
  options.write(`written ${file}\n`);

  return 0;
}
