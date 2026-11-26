import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isTicketKey } from "./ticket.ts";

export interface PlanProgress {
  done: number;
  total: number;
}

const STEP = /^- \[(.)\] \*\*(\S+?)\.\s+(.*?)\*\*/;
const PLAN_FILE = /^plan_.*\.md$/;

export function parsePlan(text: string): PlanProgress | undefined {
  let inSteps = false;
  let done = 0;
  let total = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      inSteps = line.slice(3).trim() === "Steps";
      continue;
    }

    const step = inSteps ? STEP.exec(line) : null;

    if (step === null) continue;

    total += 1;

    if (step[1] === "x") done += 1;
  }

  return total === 0 ? undefined : { done, total };
}

export interface PlanCache {
  get: (cwd: string) => PlanProgress | undefined;
}

interface Entry {
  file: string | undefined;
  dirMtime: number;
  fileMtime: number;
  progress: PlanProgress | undefined;
}

function newestPlan(dir: string): string | undefined {
  let best: string | undefined;
  let bestMtime = -Infinity;

  for (const name of readdirSync(dir)) {
    if (!PLAN_FILE.test(name)) continue;

    const mtime = statSync(join(dir, name)).mtimeMs;

    if (mtime > bestMtime) {
      best = join(dir, name);
      bestMtime = mtime;
    }
  }

  return best;
}

export function createPlanCache(base: string): PlanCache {
  const entries = new Map<string, Entry>();

  return {
    get(cwd) {
      const key = basename(cwd);

      if (!isTicketKey(key)) return undefined;

      const dir = join(base, key);

      try {
        const dirMtime = statSync(dir).mtimeMs;
        let entry = entries.get(key);

        if (entry === undefined || entry.dirMtime !== dirMtime || entry.file === undefined) {
          entry = { file: newestPlan(dir), dirMtime, fileMtime: -1, progress: undefined };
          entries.set(key, entry);
        }

        if (entry.file === undefined) return undefined;

        const fileMtime = statSync(entry.file).mtimeMs;

        if (fileMtime !== entry.fileMtime) {
          entry.progress = parsePlan(readFileSync(entry.file, "utf8"));
          entry.fileMtime = fileMtime;
        }

        return entry.progress;
      } catch {
        entries.delete(key);

        return undefined;
      }
    },
  };
}
