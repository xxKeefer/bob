#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { demo } from "../src/demo.ts";
import { handle } from "../src/hook.ts";

function stateDir(): string | undefined {
  const override = process.env.BOB_STATE_DIR;
  const path = override === undefined || override === "" ? join(homedir(), ".local", "state", "bob") : override;

  return isAbsolute(path) ? path : undefined;
}

const TMUX_TIMEOUT_MS = 200;

function tmuxSession(pane: string): string {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"], {
    encoding: "utf8",
    timeout: TMUX_TIMEOUT_MS,
  });

  return result.error === undefined && result.status === 0 ? result.stdout.trim() : "";
}

function runHook(): void {
  try {
    const dir = stateDir();

    if (dir === undefined) return;

    handle(dir, readFileSync(0, "utf8"), Math.floor(Date.now() / 1000), process.env, tmuxSession);
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
    input: process.stdin,
  };

  if (run === undefined) {
    const { main } = await import("../src/view.ts");

    await main({ ...options, stateDir: stateDir() });
  }
  else await run(options);
}

const command = process.argv[2];

if (command === "hook") runHook();
else if (command === "install") {
  const { writeSettings } = await import("../src/install.ts");
  const { hookCommand, install, installHint, isLinked } = await import("../src/view.ts");
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
else if (command === "prune") {
  const { prune } = await import("../src/prune.ts");

  process.exitCode = await prune({
    stateDir: stateDir(),
    now: Math.floor(Date.now() / 1000),
    args: process.argv.slice(3),
    input: process.stdin,
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  });
}
else if (command === "statusline") {
  const { readSessionId, statusline } = await import("../src/statusline.ts");
  const self = await readSessionId(process.stdin, 150);

  process.stdout.write(statusline(stateDir(), Math.floor(Date.now() / 1000), self));
  process.exit(0);
}
else if (command === "new") {
  const { newTicket } = await import("../src/ticket.ts");
  const { realCapture, realRun } = await import("../src/mux.ts");
  const result = newTicket(process.argv[3] ?? "", process.env, homedir(), realRun, realCapture);

  if (result.ok) process.stdout.write(`started ${process.argv[3]}\n`);
  else {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 1;
  }
}
else if (command === "demo" || command === "-d") {
  const { demo } = await import("../src/demo.ts");

  await runView(process.argv[3] === "--once", demo);
}
else if (command === undefined || command === "--once") await runView(command === "--once", undefined);
