import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EVENTS } from "./hook.ts";
import { KEY, parseKeys } from "./keys.ts";
import { loadRows } from "./rows.ts";
import type { Row } from "./rows.ts";
import { move, reconcile, START } from "./select.ts";
import type { Selection } from "./select.ts";

export interface Input {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => void;
}

export interface MainOptions {
  stateDir: string | undefined;
  once: boolean;
  intervalMs: number;
  width: number;
  color?: boolean;
  now: () => number;
  write: (text: string) => void;
  signal: AbortSignal;
  input?: Input;
}

const STATUS_COLUMN_WIDTH = 10;
const AGE_COLUMN_WIDTH = 7;
const BAR_CELLS = 8;
const CONTEXT_COLUMN_WIDTH = BAR_CELLS + 5;
const MODEL_COLUMN_WIDTH = 10;
const PROJECT_COLUMN_WIDTH = 20;
const COLUMN_GAP = 2;
const MIN_REASON_WIDTH = 20;
const MIN_PROJECT_COLUMN_WIDTH = 8;
const FULL_BAR_TOKENS = 300000;
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

const STATUS_ICON = new Map([
  ["waiting", "\u25c6"],
  ["busy", "\u25cf"],
  ["idle", "\u25cb"],
  ["stale", "\u25cc"],
]);

const CONTEXT_COLORS = [
  [100000, "32"],
  [200000, "33"],
  [FULL_BAR_TOKENS, "38;5;208"],
  [Infinity, "31"],
] as const;

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

interface ContextCell {
  text: string;
  filled: number;
  code: string;
}

function contextCell(tokens: number): ContextCell {
  const percent = Math.floor((tokens * 100) / FULL_BAR_TOKENS);
  const filled = Math.min(BAR_CELLS, Math.round((percent * BAR_CELLS) / 100));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(BAR_CELLS - filled);
  const code = CONTEXT_COLORS.find(([limit]) => tokens < limit)?.[1] ?? DIM;

  return { text: `${bar} ${`${percent}%`.padStart(4)}`, filled, code };
}

function shortModel(model: string): string {
  return clean(model).replace(/^claude-/, "").replace(/-\d{8}$/, "").slice(0, MODEL_COLUMN_WIDTH);
}

interface Layout {
  modelWidth: number;
  projectWidth: number;
}

function layout(width: number): Layout {
  const fixed = STATUS_COLUMN_WIDTH + AGE_COLUMN_WIDTH + CONTEXT_COLUMN_WIDTH + COLUMN_GAP * 4;
  const wanted = fixed + COLUMN_GAP + PROJECT_COLUMN_WIDTH + MIN_REASON_WIDTH;

  if (wanted + MODEL_COLUMN_WIDTH + COLUMN_GAP <= width) {
    return { modelWidth: MODEL_COLUMN_WIDTH, projectWidth: PROJECT_COLUMN_WIDTH };
  }

  const room = width - fixed - COLUMN_GAP - MIN_REASON_WIDTH;

  return { modelWidth: 0, projectWidth: Math.max(MIN_PROJECT_COLUMN_WIDTH, Math.min(PROJECT_COLUMN_WIDTH, room)) };
}

const GUTTER = "  ";
const MARKER = "> ";
const REVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

export function draw(rows: Row[], now: number, width: number, color = false, selected?: number): string[] {
  if (selected === undefined || rows.length === 0) return drawRows(rows, now, width, color);

  const [heading = "", ...lines] = drawRows(rows, now, width - GUTTER.length, color);

  return [
    GUTTER + heading,
    ...lines.map((line, index) => {
      if (index !== selected) return GUTTER + line;

      return color ? MARKER + REVERSE + line.replaceAll(RESET, RESET + REVERSE) + RESET : MARKER + line;
    }),
  ];
}

function drawRows(rows: Row[], now: number, width: number, color: boolean): string[] {
  if (rows.length === 0) return ["no sessions".slice(0, width)];

  const join = (parts: string[]) => parts.join(" ".repeat(COLUMN_GAP)).trimEnd().slice(0, width);
  const ageStart = STATUS_COLUMN_WIDTH + COLUMN_GAP;
  const ageEnd = ageStart + AGE_COLUMN_WIDTH;
  const contextStart = ageEnd + COLUMN_GAP;
  const { modelWidth, projectWidth } = layout(width);
  const modelSpan = modelWidth === 0 ? 0 : modelWidth + COLUMN_GAP;
  const reasonStart = contextStart + CONTEXT_COLUMN_WIDTH + COLUMN_GAP + modelSpan + projectWidth + COLUMN_GAP;

  const heading = join([
    "STATUS".padEnd(STATUS_COLUMN_WIDTH),
    "AGE".padStart(AGE_COLUMN_WIDTH),
    "CONTEXT".padEnd(CONTEXT_COLUMN_WIDTH),
    ...(modelWidth === 0 ? [] : ["MODEL".padEnd(modelWidth)]),
    "FOLDER".padEnd(projectWidth),
    "REASON",
  ]);

  const lines = rows.map((row) => {
    const cell = row.context === undefined ? undefined : contextCell(row.context.tokens);
    const icon = STATUS_ICON.get(row.status) ?? "-";

    const line = join([
      `${icon} ${clean(row.status)}`.padEnd(STATUS_COLUMN_WIDTH),
      age(now - row.since).padStart(AGE_COLUMN_WIDTH),
      (cell?.text ?? "").padEnd(CONTEXT_COLUMN_WIDTH),
      ...(modelWidth === 0 ? [] : [shortModel(row.context?.model ?? "").padEnd(modelWidth)]),
      clean(basename(row.cwd)).slice(0, projectWidth).padEnd(projectWidth),
      clean(row.reason),
    ]);

    if (!color) return line;

    const code = STATUS_COLOR.get(row.status);
    const spans: Span[] = [[ageStart, ageEnd, DIM]];

    if (code !== undefined) spans.unshift([0, STATUS_COLUMN_WIDTH, code]);

    if (cell !== undefined) {
      const barEnd = contextStart + BAR_CELLS;

      spans.push(
        [contextStart, contextStart + cell.filled, cell.code],
        [contextStart + cell.filled, barEnd, DIM],
        [barEnd + 1, contextStart + CONTEXT_COLUMN_WIDTH, cell.code],
      );
    }

    if (row.status === "waiting") spans.push([reasonStart, Infinity, REASON_COLOR]);

    return paint(line, spans);
  });

  return [color ? paint(heading, [[0, Infinity, DIM]]) : heading, ...lines];
}

export async function main(options: MainOptions): Promise<void> {
  const { input } = options;
  const keyed = !options.once && input !== undefined && input.isTTY === true && input.setRawMode !== undefined;
  const local = new AbortController();
  const abort = () => local.abort();
  let selection: Selection = START;
  let rows: Row[] = [];
  let failure: Error | undefined;
  let now = options.now();

  const render = () => {
    const lines =
      failure === undefined
        ? draw(rows, now, options.width, options.color, keyed && rows.length > 0 ? selection.index : undefined)
        : drawUnreadable(failure.message, options.width);

    options.write((options.once ? "" : CLEAR) + lines.join("\n") + "\n");
  };

  const ids = () => rows.map((row) => row.sessionId);

  const onData = (chunk: Buffer | string) => {
    for (const key of parseKeys(String(chunk))) {
      if (key === KEY.quit) return abort();

      selection = move(selection, ids(), key === KEY.down ? 1 : -1);
    }

    render();
  };

  options.signal.addEventListener("abort", abort);

  if (options.signal.aborted) abort();

  if (keyed) {
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  }

  try {
    while (!local.signal.aborted) {
      now = options.now();
      const errors: Error[] = [];

      rows = options.stateDir === undefined ? [] : loadRows(options.stateDir, now, (error) => errors.push(error));
      failure = errors[0];
      selection = reconcile(selection, ids());
      render();

      if (options.once) return;

      try {
        await sleep(options.intervalMs, undefined, { signal: local.signal });
      } catch {
        return;
      }
    }
  } finally {
    options.signal.removeEventListener("abort", abort);

    if (keyed) {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
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
