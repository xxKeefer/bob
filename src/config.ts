import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const DEFAULT_STUCK_SECONDS = 300;
export const DEFAULT_START_PROMPT = "/engineering:work-on <KEY>";

const isText = (value: string | undefined): value is string => String(value) === value;

export const DEFAULT_REVIEW_PROMPT = "/engineering:review-pr <N>";

export type ConfigResult = { ok: true; repo: string; startPrompt: string; reviewPrompt: string } | { ok: false; message: string };

function configDir(env: Record<string, string | undefined>, home: string): string {
  const override = env.BOB_CONFIG_DIR;

  return override === undefined || override === "" ? join(home, ".config", "bob") : override;
}

export function loadStuckSeconds(env: Record<string, string | undefined>, home: string): number {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir(env, home), "config.json"), "utf8"));
    const value = Number(parsed?.stuckSeconds);

    return Number.isFinite(value) && value > 0 && parsed.stuckSeconds === value ? value : DEFAULT_STUCK_SECONDS;
  } catch {
    return DEFAULT_STUCK_SECONDS;
  }
}

export function loadPlanDir(env: Record<string, string | undefined>, home: string): string {
  const fallback = join(home, "studio", "work", ".ai", "reports");
  const override = env.BOB_PLAN_DIR;

  if (isText(override) && isAbsolute(override)) return override;

  try {
    const parsed = JSON.parse(readFileSync(join(configDir(env, home), "config.json"), "utf8"));
    const value = parsed?.planDir;

    return isText(value) && isAbsolute(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function loadConfig(env: Record<string, string | undefined>, home: string): ConfigResult {
  const dir = configDir(env, home);

  if (!isAbsolute(dir)) return { ok: false, message: "config dir is not an absolute path" };

  const file = join(dir, "config.json");
  let parsed: Record<string, string | undefined>;

  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, message: `no readable config at ${file}` };
  }

  if (parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    return { ok: false, message: "config must be a json object" };
  }

  const { repo, startPrompt = DEFAULT_START_PROMPT, reviewPrompt = DEFAULT_REVIEW_PROMPT } = parsed;

  if (!isText(repo) || !isAbsolute(repo)) return { ok: false, message: "config repo must be an absolute path" };

  if (!isText(startPrompt) || startPrompt === "" || startPrompt.startsWith("-")) {
    return { ok: false, message: "config startPrompt must be a non-empty string that does not start with a dash" };
  }

  if (!isText(reviewPrompt) || reviewPrompt === "" || reviewPrompt.startsWith("-")) {
    return { ok: false, message: "config reviewPrompt must be a non-empty string that does not start with a dash" };
  }

  return { ok: true, repo, startPrompt, reviewPrompt };
}
