import { loadConfig } from "./config.ts";
import type { Capture, Run, RunResult } from "./mux.ts";
import { launch } from "./ticket.ts";

const PR_NUMBER = /^\d+$/;
const BRANCH = /^[^-\s]\S*$/;

export function isPrNumber(value: string): boolean {
  return PR_NUMBER.test(value);
}

function headBranch(stdout: string): string | undefined {
  try {
    const { headRefName } = JSON.parse(stdout);

    return BRANCH.test(String(headRefName)) && String(headRefName) === headRefName ? headRefName : undefined;
  } catch {
    return undefined;
  }
}

export function newReview(
  number: string,
  env: Record<string, string | undefined>,
  home: string,
  run: Run,
  capture: Capture,
  mark: (path: string) => void,
): RunResult {
  if (!isPrNumber(number)) return { ok: false, message: "PR number looks like 123" };

  const config = loadConfig(env, home);

  if (!config.ok) return config;

  const found = capture(["gh", "pr", "view", number, "--json", "headRefName"], config.repo);

  if (!found.ok) return found;

  const branch = headBranch(found.stdout);

  if (branch === undefined) return { ok: false, message: `no branch found for PR ${number}` };

  const launched = launch(config, [], branch, config.reviewPrompt.replaceAll("<N>", number), env, run, capture);

  if (!launched.ok) return launched;

  mark(launched.path);

  return { ok: true };
}
