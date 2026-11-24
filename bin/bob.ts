#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook.ts";

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

if (process.argv[2] === "hook") runHook();
