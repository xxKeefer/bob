#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { demo } from "../src/demo.ts";
import { handle } from "../src/hook.ts";
import { install, installHint, isLinked, main } from "../src/view.ts";

function stateDir(): string | undefined {
  const override = process.env.BOB_STATE_DIR;
  const path = override === undefined || override === "" ? join(homedir(), ".local", "state", "bob") : override;

  return isAbsolute(path) ? path : undefined;
}

function runHook(): void {
  try {
    const dir = stateDir();

    if (dir === undefined) return;

    handle(dir, readFileSync(0, "utf8"), Math.floor(Date.now() / 1000));
  } catch {
    void 0;
  }
}

async function runView(once: boolean, run: typeof demo | undefined): Promise<void> {
  const controller = new AbortController();

  process.once("SIGINT", () => controller.abort());

  const options = {
    once,
    intervalMs: 1000,
    width: process.stdout.columns || 80,
    now: () => Math.floor(Date.now() / 1000),
    write: (text: string) => process.stdout.write(text),
    signal: controller.signal,
  };

  if (run === undefined) await main({ ...options, stateDir: stateDir() });
  else await run(options);
}

const command = process.argv[2];

if (command === "hook") runHook();
else if (command === "install") {
  const script = join(import.meta.dirname, "..", "bin", "bob.ts");

  process.stdout.write(install(script));

  if (!isLinked(script)) process.stderr.write(installHint(script));
}
else if (command === "demo") await runView(process.argv[3] === "--once", demo);
else if (command === undefined || command === "--once") await runView(command === "--once", undefined);
