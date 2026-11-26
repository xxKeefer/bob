import { execFile } from "node:child_process";


export type ExecResult = { ok: true; stdout: string } | { ok: false; message: string };

export type Exec = (argv: string[], cwd: string) => Promise<ExecResult>;

export type PrState = "draft" | "open" | "merged" | "closed";

export type Ci = "pass" | "fail" | "pending" | "none";

export type Review = "approved" | "changes" | "required" | "none";

export interface PrInfo {
  state: PrState;
  ci: Ci;
  review: Review;
}

export interface PrCache {
  get: (key: string) => PrInfo | undefined;
}

export interface PrCacheOptions {
  exec: Exec;
  now: () => number;
  ttl?: number;
  backoff?: number;
}

const EXEC_TIMEOUT_MS = 10000;
const DEFAULT_TTL = 30;
const DEFAULT_BACKOFF = 120;
const NO_PR = /no pull requests? found/i;
const FIELDS = "state,isDraft,statusCheckRollup,reviewDecision";
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const PENDING = new Set(["PENDING", "EXPECTED"]);

export const realExec: Exec = (argv, cwd) =>
  new Promise((resolve) => {
    const [command = "", ...args] = argv;

    execFile(command, args, { cwd, timeout: EXEC_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return resolve({ ok: true, stdout });

      const code = "code" in error ? error.code : undefined;
      const message = code === "ENOENT" ? `${command} not found` : stderr.trim().split("\n")[0] || error.message;

      resolve({ ok: false, message });
    });
  });

interface Check {
  status?: string;
  conclusion?: string;
  state?: string;
}

interface GhPr {
  state?: string;
  isDraft?: boolean;
  statusCheckRollup?: Check[] | null;
  reviewDecision?: string;
}

function ciOf(rollup: Check[] | null | undefined): Ci {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";

  let pending = false;

  for (const check of rollup) {
    const verdict = check.state ?? check.conclusion ?? "";

    if (FAILED.has(verdict)) return "fail";

    if (PENDING.has(verdict) || (check.status !== undefined && check.status !== "COMPLETED")) pending = true;
  }

  return pending ? "pending" : "pass";
}

const REVIEWS = new Map<string, Review>([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes"],
  ["REVIEW_REQUIRED", "required"],
]);

export function parsePr(stdout: string): PrInfo | undefined {
  let data: GhPr | null;

  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (data === null || Array.isArray(data)) return undefined;

  let state: PrState = "open";

  if (data.state === "MERGED") state = "merged";
  else if (data.state === "CLOSED") state = "closed";
  else if (data.isDraft === true) state = "draft";

  return { state, ci: ciOf(data.statusCheckRollup), review: REVIEWS.get(data.reviewDecision ?? "") ?? "none" };
}

type Fetched = { ok: true; info: PrInfo | undefined } | { ok: false };

async function fetchPr(exec: Exec, cwd: string): Promise<Fetched> {
  const branch = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);

  if (!branch.ok) return { ok: false };

  const name = branch.stdout.trim();

  if (name === "" || name === "HEAD") return { ok: true, info: undefined };

  const view = await exec(["gh", "pr", "view", name, "--json", FIELDS], cwd);

  if (!view.ok) return NO_PR.test(view.message) ? { ok: true, info: undefined } : { ok: false };

  const info = parsePr(view.stdout);

  return info === undefined ? { ok: false } : { ok: true, info };
}

interface Entry {
  info: PrInfo | undefined;
  nextAt: number;
  inflight: boolean;
}

export function createPrCache(options: PrCacheOptions): PrCache {
  const { exec, now } = options;
  const ttl = options.ttl ?? DEFAULT_TTL;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const entries = new Map<string, Entry>();

  const refresh = (key: string, entry: Entry) => {
    entry.inflight = true;

    fetchPr(exec, key)
      .then((result) => {
        if (result.ok) {
          entry.info = result.info;
          entry.nextAt = now() + ttl;
        } else entry.nextAt = now() + backoff;
      })
      .catch(() => {
        entry.nextAt = now() + backoff;
      })
      .finally(() => {
        entry.inflight = false;
      });
  };

  return {
    get(key) {
      let entry = entries.get(key);

      if (entry === undefined) {
        entry = { info: undefined, nextAt: 0, inflight: false };
        entries.set(key, entry);
      }

      if (!entry.inflight && now() >= entry.nextAt) refresh(key, entry);

      return entry.info;
    },
  };
}
