import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "reviews.json";

export function readReviews(stateDir: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, FILE), "utf8"));

    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => String(entry) === entry) : []);
  } catch {
    return new Set();
  }
}

export function markReview(stateDir: string, cwd: string): void {
  const reviews = readReviews(stateDir).add(cwd);
  const temp = join(stateDir, `${FILE}.${process.pid}.tmp`);

  writeFileSync(temp, JSON.stringify([...reviews]));
  renameSync(temp, join(stateDir, FILE));
}
