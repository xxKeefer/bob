import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadRows } from "./rows.ts";
import type { Row } from "./rows.ts";

export interface MainOptions {
  stateDir: string;
  once: boolean;
  intervalMs: number;
  width: number;
  now: () => number;
  write: (text: string) => void;
  signal: AbortSignal;
}

const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

const CLEAR = "\x1b[H\x1b[2J";

function age(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));

  if (total < 60) return `${total}s`;

  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;

  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

export function draw(rows: Row[], now: number, width: number): string[] {
  if (rows.length === 0) return ["no sessions".slice(0, width)];

  return rows.map((row) => {
    const parts = [row.status.padEnd(8), age(now - row.since).padStart(7), basename(row.cwd).padEnd(20), row.reason];

    return parts.join("  ").trimEnd().slice(0, width);
  });
}

export async function main(options: MainOptions): Promise<void> {
  while (!options.signal.aborted) {
    const now = options.now();
    const lines = draw(loadRows(options.stateDir, now), now, options.width);

    options.write(options.once ? lines.join("\n") + "\n" : CLEAR + lines.join("\n") + "\n");

    if (options.once) return;

    try {
      await sleep(options.intervalMs, undefined, { signal: options.signal });
    } catch {
      return;
    }
  }
}

export function install(): string {
  const command = `node ${join(import.meta.dirname, "..", "bin", "bob.ts")} hook`;
  const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command }] }]]));

  return JSON.stringify({ hooks }, null, 2) + "\n";
}
