#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook.ts";
import { install, main } from "../src/view.ts";

function stateDir(): string {
  return process.env.BOB_STATE_DIR ?? join(homedir(), ".local", "state", "bob");
}

function runHook(): void {
  try {
    handle(stateDir(), readFileSync(0, "utf8"), Math.floor(Date.now() / 1000));
  } catch {
    void 0;
  }
}

async function runView(): Promise<void> {
  const controller = new AbortController();

  process.once("SIGINT", () => controller.abort());

  await main({
    stateDir: stateDir(),
    once: process.argv[2] === "--once",
    intervalMs: 1000,
    width: process.stdout.columns || 80,
    now: () => Math.floor(Date.now() / 1000),
    write: (text) => process.stdout.write(text),
    signal: controller.signal,
  });
}

const command = process.argv[2];

if (command === "hook") runHook();
else if (command === "install") process.stdout.write(install());
else if (command === undefined || command === "--once") await runView();
