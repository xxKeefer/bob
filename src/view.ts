import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EVENTS } from "./hook.ts";
import { attachKeys, KEY } from "./keys.ts";
import type { Key } from "./keys.ts";
import type { KeyInput } from "./keys.ts";
import { focus, open, realCapture, realRun } from "./mux.ts";
import type { Capture, Run, RunResult } from "./mux.ts";
import type { PlanCache, PlanProgress } from "./plan.ts";
import type { Exec, PrCache, PrInfo } from "./pr.ts";
import { DEFAULT_STUCK_SECONDS, loadRows } from "./rows.ts";
import type { Row } from "./rows.ts";
import { move, reconcile, START } from "./select.ts";
import type { Selection } from "./select.ts";

export interface Input extends KeyInput {
  isTTY?: boolean;
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
  run?: Run;
  capture?: Capture;
  exec?: Exec;
  env?: Record<string, string | undefined>;
}

const STATUS_COLUMN_WIDTH = 10;
const AGE_COLUMN_WIDTH = 7;
const BAR_CELLS = 8;
const CONTEXT_COLUMN_WIDTH = BAR_CELLS + 5;
const MODEL_COLUMN_WIDTH = 10;
const PR_COLUMN_WIDTH = 13;
const PLAN_COLUMN_WIDTH = 7;
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

const MAX_PROMPT = 40;
const CLEAR = "\x1b[H\x1b[2J";
const DIM = "2";
const REASON_COLOR = "33";

const STATUS_COLOR = new Map([
  ["waiting", "1;33"],
  ["stuck", "31"],
  ["busy", "32"],
  ["idle", "36"],
  ["stale", DIM],
]);

const STATUS_ICON = new Map([
  ["waiting", "\u25c6"],
  ["stuck", "\u25a0"],
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
  planWidth: number;
  prWidth: number;
  projectWidth: number;
}

const PR_GLYPH = new Map([
  ["pass", "\u2713"],
  ["fail", "\u2717"],
  ["pending", "\u2026"],
  ["none", "-"],
]);

const PR_REVIEW = new Map([
  ["approved", "appr"],
  ["changes", "chg"],
  ["required", "rev"],
]);

const CI_COLOR = new Map([
  ["pass", "32"],
  ["fail", "31"],
  ["pending", "33"],
]);

function prCell(info: PrInfo): string {
  return `${info.state.padEnd(6)} ${PR_GLYPH.get(info.ci) ?? "-"} ${PR_REVIEW.get(info.review) ?? ""}`.trimEnd();
}

function layout(width: number, withPr: boolean, withPlan: boolean): Layout {
  const fixed = STATUS_COLUMN_WIDTH + AGE_COLUMN_WIDTH + CONTEXT_COLUMN_WIDTH + COLUMN_GAP * 4;
  const tiers = [{ model: true, plan: withPlan, pr: withPr }];

  if (withPlan && withPr) tiers.push({ model: false, plan: true, pr: true }, { model: false, plan: false, pr: true });
  else if (withPlan || withPr) tiers.push({ model: false, plan: withPlan, pr: withPr });

  for (const [index, tier] of tiers.entries()) {
    const modelWidth = tier.model ? MODEL_COLUMN_WIDTH : 0;
    const planWidth = tier.plan ? PLAN_COLUMN_WIDTH : 0;
    const prWidth = tier.pr ? PR_COLUMN_WIDTH : 0;
    const spans = [modelWidth, planWidth, prWidth].reduce((sum, value) => sum + (value === 0 ? 0 : value + COLUMN_GAP), 0);
    const room = width - fixed - COLUMN_GAP - MIN_REASON_WIDTH - spans;
    const needed = index === 0 ? PROJECT_COLUMN_WIDTH : MIN_PROJECT_COLUMN_WIDTH;

    if (room >= needed) return { modelWidth, planWidth, prWidth, projectWidth: Math.min(PROJECT_COLUMN_WIDTH, room) };
  }

  const bare = width - fixed - COLUMN_GAP - MIN_REASON_WIDTH;

  return { modelWidth: 0, planWidth: 0, prWidth: 0, projectWidth: Math.max(MIN_PROJECT_COLUMN_WIDTH, Math.min(PROJECT_COLUMN_WIDTH, bare)) };
}

const GUTTER = "  ";
const MARKER = "> ";
const REVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

export function draw(
  rows: Row[],
  now: number,
  width: number,
  color = false,
  selected?: number,
  prs: Map<string, PrInfo> = new Map(),
  plans: Map<string, PlanProgress> = new Map(),
): string[] {
  if (selected === undefined || rows.length === 0) return drawRows(rows, now, width, color, prs, plans);

  const [heading = "", ...lines] = drawRows(rows, now, width - GUTTER.length, color, prs, plans);

  return [
    GUTTER + heading,
    ...lines.map((line, index) => {
      if (index !== selected) return GUTTER + line;

      return color ? MARKER + REVERSE + line.replaceAll(RESET, RESET + REVERSE) + RESET : MARKER + line;
    }),
  ];
}

function drawRows(
  rows: Row[],
  now: number,
  width: number,
  color: boolean,
  prs: Map<string, PrInfo>,
  plans: Map<string, PlanProgress>,
): string[] {
  if (rows.length === 0) return ["no sessions".slice(0, width)];

  const join = (parts: string[]) => parts.join(" ".repeat(COLUMN_GAP)).trimEnd().slice(0, width);
  const ageStart = STATUS_COLUMN_WIDTH + COLUMN_GAP;
  const ageEnd = ageStart + AGE_COLUMN_WIDTH;
  const contextStart = ageEnd + COLUMN_GAP;
  const withPr = rows.some((row) => prs.has(row.cwd));
  const withPlan = rows.some((row) => plans.has(row.cwd));
  const { modelWidth, planWidth, prWidth, projectWidth } = layout(width, withPr, withPlan);
  const modelSpan = modelWidth === 0 ? 0 : modelWidth + COLUMN_GAP;
  const planSpan = planWidth === 0 ? 0 : planWidth + COLUMN_GAP;
  const prSpan = prWidth === 0 ? 0 : prWidth + COLUMN_GAP;
  const reasonStart = contextStart + CONTEXT_COLUMN_WIDTH + COLUMN_GAP + modelSpan + projectWidth + COLUMN_GAP + planSpan + prSpan;
  const prStart = reasonStart - prSpan;

  const heading = join([
    "STATUS".padEnd(STATUS_COLUMN_WIDTH),
    "AGE".padStart(AGE_COLUMN_WIDTH),
    "CONTEXT".padEnd(CONTEXT_COLUMN_WIDTH),
    ...(modelWidth === 0 ? [] : ["MODEL".padEnd(modelWidth)]),
    "FOLDER".padEnd(projectWidth),
    ...(planWidth === 0 ? [] : ["PLAN".padEnd(planWidth)]),
    ...(prWidth === 0 ? [] : ["PR".padEnd(prWidth)]),
    "REASON",
  ]);

  const lines = rows.map((row) => {
    const cell = row.context === undefined ? undefined : contextCell(row.context.tokens);
    const icon = STATUS_ICON.get(row.status) ?? "-";
    const pr = prs.get(row.cwd);
    const plan = plans.get(row.cwd);

    const line = join([
      `${icon} ${clean(row.status)}`.padEnd(STATUS_COLUMN_WIDTH),
      age(now - row.since).padStart(AGE_COLUMN_WIDTH),
      (cell?.text ?? "").padEnd(CONTEXT_COLUMN_WIDTH),
      ...(modelWidth === 0 ? [] : [shortModel(row.context?.model ?? "").padEnd(modelWidth)]),
      `${row.review ? "review " : ""}${clean(basename(row.cwd))}`.slice(0, projectWidth).padEnd(projectWidth),
      ...(planWidth === 0 ? [] : [(plan === undefined ? "" : `${plan.done}/${plan.total}`).padEnd(planWidth)]),
      ...(prWidth === 0 ? [] : [(pr === undefined ? "" : prCell(pr)).padEnd(prWidth)]),
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

    const ciCode = pr === undefined ? undefined : CI_COLOR.get(pr.ci);

    if (prWidth !== 0 && ciCode !== undefined) spans.push([prStart, prStart + prWidth, ciCode]);

    if (row.status === "waiting") spans.push([reasonStart, Infinity, REASON_COLOR]);

    return paint(line, spans);
  });

  return [color ? paint(heading, [[0, Infinity, DIM]]) : heading, ...lines];
}

export async function main(options: MainOptions): Promise<void> {
  const { input } = options;
  const readsKeys = !options.once && input !== undefined && input.isTTY === true && input.setRawMode !== undefined;
  const local = new AbortController();
  const abort = () => local.abort();
  let selection: Selection = START;
  let rows: Row[] = [];
  let failure: Error | undefined;
  let now = options.now();
  let message = "";
  let prompt: string | undefined;
  let reviewing = false;
  let confirming: Row | undefined;
  let prCache: PrCache | undefined;
  let prs = new Map<string, PrInfo>();
  let plans = new Map<string, PlanProgress>();
  let planCache: PlanCache | undefined;
  let stuckSeconds = DEFAULT_STUCK_SECONDS;
  let writeSelected: ((folder: string) => void) | undefined;
  let lastSelected: string | undefined;

  const syncSelected = () => {
    if (writeSelected === undefined || !readsKeys) return;

    const folder = rows.find((row) => row.sessionId === selection.id)?.cwd ?? "";

    if (folder === lastSelected) return;

    lastSelected = folder;

    try {
      writeSelected(folder);
    } catch {
      void 0;
    }
  };

  const render = () => {
    syncSelected();

    const lines =
      failure === undefined
        ? draw(rows, now, options.width, options.color, readsKeys && rows.length > 0 ? selection.index : undefined, prs, plans)
        : drawUnreadable(failure.message, options.width);

    if (message !== "") lines.push(clean(message).slice(0, options.width));

    if (prompt !== undefined) lines.push(`${reviewing ? "review PR" : "ticket"}: ${clean(prompt)}`.slice(0, options.width));

    if (confirming !== undefined) lines.push(`remove ${clean(basename(confirming.cwd))} and close its window? y/N`.slice(0, options.width));

    options.write((options.once ? "" : CLEAR) + lines.join("\n") + "\n");
  };

  const ids = () => rows.map((row) => row.sessionId);

  const start = (key: string) => {
    message = `starting ${clean(key)}...`;
    render();

    void Promise.all([import("./ticket.ts"), import("./dev.ts")]).then(async ([{ newTicket }, { devStarter }]) => {
      const env = options.env ?? process.env;
      const run = options.run ?? realRun;
      const startDev = devStarter({ env, home: homedir(), stateDir: options.stateDir, run });
      let dev: Promise<RunResult> | undefined;

      const result = newTicket(
        key,
        env,
        homedir(),
        run,
        options.capture ?? realCapture,
        startDev === undefined ? undefined : (path) => void (dev = startDev(path)),
      );

      const devResult = dev === undefined ? result : await dev;

      message = result.ok ? (devResult.ok ? "" : devResult.message) : result.message;
      render();
    });
  };

  const startReview = (number: string) => {
    message = `starting review of ${clean(number)}...`;
    render();

    void Promise.all([import("./review.ts"), import("./reviews.ts")]).then(([{ newReview }, { markReview }]) => {
      const result = newReview(
        number,
        options.env ?? process.env,
        homedir(),
        options.run ?? realRun,
        options.capture ?? realCapture,
        (path) => {
          if (options.stateDir !== undefined) markReview(options.stateDir, path);
        },
      );

      message = result.ok ? "" : result.message;
      render();
    });
  };

  const finish = (row: Row) => {
    message = `removing ${clean(basename(row.cwd))}...`;
    render();

    void import("./cleanup.ts").then(({ cleanup, deleteRow }) => {
      const result = cleanup(row, {
        env: options.env ?? process.env,
        home: homedir(),
        run: options.run ?? realRun,
        capture: options.capture ?? realCapture,
        remove: () => {
          if (options.stateDir !== undefined) deleteRow(options.stateDir, row.sessionId);
        },
      });

      message = result.ok ? "" : result.message;
      render();
    });
  };

  const capturePrompt = (text: string): boolean => {
    if (confirming !== undefined) {
      const row = confirming;

      confirming = undefined;

      if (text === "y" || text === "Y") finish(row);
      else message = "";

      render();

      return true;
    }

    if (prompt === undefined) return false;

    if (text === "\x1b" || text === "\x03") {
      prompt = undefined;
      message = "";
    } else if (!text.startsWith("\x1b")) {
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          const key = prompt;

          prompt = undefined;

          if (reviewing) startReview(key);
          else start(key);

          break;
        }

        if (char === "\x7f" || char === "\b") prompt = prompt.slice(0, -1);
        else if (char >= " " && char <= "~" && prompt.length < MAX_PROMPT) prompt += char;
      }
    }

    render();

    return true;
  };

  const onKeys = (keys: Key[]) => {
    for (const key of keys) {
      if (key === KEY.quit) return abort();

      if (key === KEY.enter) {
        const row = rows.find((candidate) => candidate.sessionId === selection.id);

        if (row === undefined) continue;

        const result = focus(row.multiplexer, row.muxSession, row.paneId, options.run ?? realRun);

        message = result.ok ? "" : result.message;
        continue;
      }

      if (key === KEY.review) {
        prompt = "";
        reviewing = true;
        message = "";
        continue;
      }

      if (key === KEY.ticket) {
        prompt = "";
        reviewing = false;
        message = "";
        continue;
      }

      if (key === KEY.clean) {
        const row = rows.find((candidate) => candidate.sessionId === selection.id);

        if (row === undefined) continue;

        if (prs.get(row.cwd)?.state !== "merged") message = "PR not merged, nothing removed";
        else {
          confirming = row;
          message = "";
        }

        continue;
      }

      if (key === KEY.restart) {
        const row = rows.find((candidate) => candidate.sessionId === selection.id);

        if (row === undefined) continue;

        if (row.status !== "stuck") {
          message = "session is not stuck, nothing restarted";
          continue;
        }

        message = `restarting ${clean(basename(row.cwd))}...`;
        render();

        void import("./restart.ts").then(({ restart }) => {
          const result = restart(row.multiplexer, row.muxSession, row.paneId, row.cwd, options.run ?? realRun);

          message = result.ok ? "" : result.message;
          render();
        });

        continue;
      }

      if (key === KEY.new) {
        const row = rows.find((candidate) => candidate.sessionId === selection.id);

        if (row === undefined) continue;

        const result = open(options.env ?? process.env, row.cwd, options.run ?? realRun);

        message = result.ok ? "" : result.message;
        continue;
      }

      const next = move(selection, ids(), key === KEY.down ? 1 : -1);

      if (next.id !== selection.id) message = "";

      selection = next;
    }

    render();
  };

  options.signal.addEventListener("abort", abort);

  if (options.signal.aborted) abort();

  const detach = readsKeys ? attachKeys(input, onKeys, capturePrompt) : undefined;

  try {
    const loaded = Promise.all([import("./config.ts"), import("./plan.ts")]).then(([{ loadStuckSeconds, loadPlanDir, loadDev }, { createPlanCache }]) => {
      const stateDir = options.stateDir;

      if (!options.once && stateDir !== undefined && loadDev(options.env ?? process.env, homedir()) !== undefined) {
        void import("./dev.ts").then((dev) => {
          writeSelected = (folder) => dev.writeSelected(stateDir, folder);
          syncSelected();
        });
      }

      stuckSeconds = loadStuckSeconds(options.env ?? process.env, homedir());
      planCache = createPlanCache(loadPlanDir(options.env ?? process.env, homedir()));
    });

    if (options.once) await loaded;

    if (!options.once) {
      void import("./pr.ts").then(({ createPrCache, realExec }) => {
        prCache = createPrCache({ exec: options.exec ?? realExec, now: options.now });
      });
    }

    while (!local.signal.aborted) {
      now = options.now();
      const errors: Error[] = [];

      rows = options.stateDir === undefined ? [] : loadRows(options.stateDir, now, (error) => errors.push(error), stuckSeconds);
      failure = errors[0];
      prs = new Map();
      plans = new Map();

      for (const row of rows) {
        const info = prCache?.get(row.cwd);

        if (info !== undefined) prs.set(row.cwd, info);

        const progress = planCache?.get(row.cwd);

        if (progress !== undefined) plans.set(row.cwd, progress);
      }

      const reconciled = reconcile(selection, ids());

      if (reconciled.id !== selection.id) message = "";

      selection = reconciled;
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

    detach?.();
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
