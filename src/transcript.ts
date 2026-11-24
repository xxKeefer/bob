import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

const TAIL_BYTES = 524288;
const SYNTHETIC_MODEL = "<synthetic>";

export interface Usage {
  tokens: number;
  model: string;
}

interface Entry {
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function count(value: number | undefined): number {
  return Number(value) || 0;
}

function parseUsage(line: string): Usage | undefined {
  try {
    const entry: Entry | null = JSON.parse(line);
    const usage = entry?.message?.usage;
    const model = entry?.message?.model;

    if (!usage || !model || model === SYNTHETIC_MODEL) return undefined;

    return {
      tokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
      model: String(model),
    };
  } catch {
    return undefined;
  }
}

export function readUsage(path: string): Usage | undefined {
  if (path === "") return undefined;

  try {
    if (!statSync(path).isFile()) return undefined;

    const fd = openSync(path, "r");

    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);

      readSync(fd, buffer, 0, buffer.length, start);

      for (const line of buffer.toString("utf8").split("\n").reverse()) {
        const usage = parseUsage(line);

        if (usage !== undefined) return usage;
      }

      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
