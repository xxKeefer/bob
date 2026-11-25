#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { demo } from "../src/demo.ts";
import { handle } from "../src/hook.ts";
import { writeSettings } from "../src/install.ts";
import { hookCommand, install, installHint, isLinked, main } from "../src/view.ts";

function stateDir(): string | undefined {
  const override = process.env.BOB_STATE_DIR;
  const path = override === undefined || override === "" ? join(homedir(), ".local", "state", "bob") : override;

  return isAbsolute(path) ? path : undefined;
}

function runHook(): void {
  try {
    const dir = stateDir();

    if (dir === undefined) return;

    handle(dir, readFileSync(0, "utf8"), Math.floor(Date.now() / 1000), process.env);
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
    width: process.stdout.columns || 120,
    color: process.stdout.isTTY && !process.env.NO_COLOR,
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

  if (process.argv[3] === "--write") {
    process.exitCode = await writeSettings({
      home: process.env.HOME,
      command: hookCommand(script),
      input: process.stdin,
      write: (text) => process.stdout.write(text),
      writeError: (text) => process.stderr.write(text),
      now: () => Date.now(),
    });
  } else {
    process.stdout.write(install(script));

    if (!isLinked(script)) process.stderr.write(installHint(script));
  }
}
else if (command === "demo" || command === "-d") await runView(process.argv[3] === "--once", demo);
else if (command === undefined || command === "--once") await runView(command === "--once", undefined);
