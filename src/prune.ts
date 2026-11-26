import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";

const BUSY_TIMEOUT_MS = 200;
const DEFAULT_AGE = "7d";

const UNITS = new Map([
  ["s", 1],
  ["m", 60],
  ["h", 3600],
  ["d", 86400],
  ["w", 604800],
]);

export interface PruneOptions {
  stateDir: string | undefined;
  now: number;
  args: string[];
  input: Readable;
  write: (text: string) => void;
  writeError: (text: string) => void;
}

export function parseAge(text: string): number | undefined {
  const match = /^([1-9][0-9]*)([smhdw])$/.exec(text);

  if (match === null) return undefined;

  return Number(match[1]) * (UNITS.get(match[2] ?? "") ?? 0);
}

interface Parsed {
  age: string;
  yes: boolean;
  error: string | undefined;
}

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { age: DEFAULT_AGE, yes: false, error: undefined };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--older-than") {
      const value = args[index + 1];

      if (value === undefined) parsed.error = "--older-than needs an age such as 7d";
      else parsed.age = value;

      index += 1;
    } else if (arg.startsWith("--older-than=")) parsed.age = arg.slice("--older-than=".length);
    else parsed.error = "unknown argument: " + arg;
  }

  return parsed;
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

function plural(count: number): string {
  return count + (count === 1 ? " row" : " rows");
}

export async function prune(options: PruneOptions): Promise<number> {
  const { stateDir, now, args, input, write, writeError } = options;
  const parsed = parseArgs(args);
  const seconds = parseAge(parsed.age);

  if (parsed.error === undefined && seconds === undefined) parsed.error = "bad age: " + parsed.age + " (use a number and s, m, h, d, or w)";

  if (parsed.error !== undefined || seconds === undefined) {
    writeError("bob prune: " + (parsed.error ?? "bad age") + "\nusage: bob prune [--older-than <age>] [--yes]\n");

    return 1;
  }

  if (stateDir === undefined) {
    writeError("bob prune: BOB_STATE_DIR must be an absolute path\n");

    return 1;
  }

  const file = join(stateDir, "bob.db");

  if (!existsSync(file)) {
    write("Nothing to prune.\n");

    return 0;
  }

  const cutoff = now - seconds;

  try {
    const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });

    try {
      const table = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'sessions'").get();
      const found = table === undefined ? 0 : Number(db.prepare("select count(*) as n from sessions where updated < ?").get(cutoff)?.n);

      if (found === 0) {
        write("Nothing to prune.\n");

        return 0;
      }

      if (!parsed.yes) {
        write("Delete " + plural(found) + " not updated in " + parsed.age + "? [y/N] ");

        const answer = (await ask(input)).trim().toLowerCase();

        if (answer !== "y" && answer !== "yes") {
          write("Nothing deleted.\n");

          return 0;
        }
      }

      const removed = Number(db.prepare("delete from sessions where updated < ?").run(cutoff).changes);

      write("Deleted " + plural(removed) + ".\n");

      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    writeError("bob prune: " + (error instanceof Error ? error.message : String(error)) + "\n");

    return 1;
  }
}
