import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EVENTS } from "./hook.ts";
import { loadRows } from "./rows.ts";
import type { Row } from "./rows.ts";

export interface MainOptions {
  stateDir: string | undefined;
  once: boolean;
  intervalMs: number;
  width: number;
  color?: boolean;
  now: () => number;
  write: (text: string) => void;
  signal: AbortSignal;
}

const STATUS_COLUMN_WIDTH = 8;
const AGE_COLUMN_WIDTH = 7;
const PROJECT_COLUMN_WIDTH = 20;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const CONTROL_WHITESPACE = /[\n\r\t]+/g;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function clean(value: string): string {
  return value.replace(CONTROL_WHITESPACE, " ").replace(CONTROL_CHARACTERS, "");
}

const CLEAR = "\x1b[H\x1b[2J";
const DIM = "2";
const REASON_COLOR = "33";

const STATUS_COLOR = new Map([
  ["waiting", "1;33"],
  ["busy", "32"],
  ["idle", "36"],
  ["stale", DIM],
]);

function age(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));

  if (total < SECONDS_PER_MINUTE) return `${total}s`;

  if (total < SECONDS_PER_HOUR) {
    return `${Math.floor(total / SECONDS_PER_MINUTE)}m${String(total % SECONDS_PER_MINUTE).padStart(2, "0")}s`;
  }

  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);

  return `${Math.floor(total / SECONDS_PER_HOUR)}h${String(minutes).padStart(2, "0")}m`;
}

export function drawUnreadable(message: string, width: number): string[] {
  return [`db unreadable: ${clean(message)}`.slice(0, width)];
}

type Span = [start: number, end: number, code: string];

function paint(line: string, spans: Span[]): string {
  let out = "";
  let position = 0;

  for (const [start, end, code] of spans) {
    const text = line.slice(start, end);

    out += line.slice(position, start) + (text === "" ? "" : `\x1b[${code}m${text}\x1b[0m`);
    position = Math.max(position, end);
  }

  return out + line.slice(position);
}

export function draw(rows: Row[], now: number, width: number, color = false): string[] {
  if (rows.length === 0) return ["no sessions".slice(0, width)];

  const join = (parts: string[]) => parts.join("  ").trimEnd().slice(0, width);
  const ageStart = STATUS_COLUMN_WIDTH + 2;
  const ageEnd = ageStart + AGE_COLUMN_WIDTH;
  const reasonStart = ageEnd + 2 + PROJECT_COLUMN_WIDTH + 2;

  const heading = join([
    "STATUS".padEnd(STATUS_COLUMN_WIDTH),
    "AGE".padStart(AGE_COLUMN_WIDTH),
    "FOLDER".padEnd(PROJECT_COLUMN_WIDTH),
    "REASON",
  ]);

  const lines = rows.map((row) => {
    const line = join([
      clean(row.status).padEnd(STATUS_COLUMN_WIDTH),
      age(now - row.since).padStart(AGE_COLUMN_WIDTH),
      clean(basename(row.cwd)).padEnd(PROJECT_COLUMN_WIDTH),
      clean(row.reason),
    ]);

    if (!color) return line;

    const code = STATUS_COLOR.get(row.status);
    const spans: Span[] = [[ageStart, ageEnd, DIM]];

    if (code !== undefined) spans.unshift([0, STATUS_COLUMN_WIDTH, code]);

    if (row.status === "waiting") spans.push([reasonStart, Infinity, REASON_COLOR]);

    return paint(line, spans);
  });

  return [color ? paint(heading, [[0, Infinity, DIM]]) : heading, ...lines];
}

export async function main(options: MainOptions): Promise<void> {
  while (!options.signal.aborted) {
    const now = options.now();
    const errors: Error[] = [];

    const rows =
      options.stateDir === undefined ? [] : loadRows(options.stateDir, now, (error) => errors.push(error));

    const [failure] = errors;

    const lines =
      failure === undefined
        ? draw(rows, now, options.width, options.color)
        : drawUnreadable(failure.message, options.width);

    options.write((options.once ? "" : CLEAR) + lines.join("\n") + "\n");

    if (options.once) return;

    try {
      await sleep(options.intervalMs, undefined, { signal: options.signal });
    } catch {
      return;
    }
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);

    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isLinked(script: string, pathEnv = process.env.PATH ?? ""): boolean {
  try {
    const first = pathEnv
      .split(delimiter)
      .filter((dir) => dir !== "" && isAbsolute(dir))
      .map((dir) => join(dir, "bob"))
      .find(isExecutableFile);

    return first !== undefined && realpathSync(first) === realpathSync(script);
  } catch {
    return false;
  }
}

export function installHint(script: string): string {
  return `ln -s ${script} ~/.local/bin/bob\n`;
}

export function hookCommand(script: string, pathEnv = process.env.PATH ?? ""): string {
  return isLinked(script, pathEnv) ? "bob hook" : `node ${quote(script)} hook`;
}

export function install(
  script = join(import.meta.dirname, "..", "bin", "bob.ts"),
  pathEnv = process.env.PATH ?? "",
): string {
  const command = hookCommand(script, pathEnv);
  const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command }] }]]));

  return JSON.stringify({ hooks }, null, 2) + "\n";
}
