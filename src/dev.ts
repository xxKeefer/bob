import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { loadDev } from "./config.ts";
import { openPane } from "./mux.ts";
import type { Run, RunResult } from "./mux.ts";

const PORTS_FILE = "ports.json";
const SELECTED_FILE = "selected";
const PORT_LINE = /^PORT=/;

export type IsFree = (port: number) => Promise<boolean>;

export const realIsFree: IsFree = (port) =>
  new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });

export async function pickPort(min: number, max: number, taken: Set<number>, isFree: IsFree): Promise<number | undefined> {
  for (let port = min; port <= max; port += 1) {
    if (!taken.has(port) && (await isFree(port))) return port;
  }

  return undefined;
}

export function setPort(text: string, port: number): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const index = lines.findIndex((line) => PORT_LINE.test(line));

  if (index === -1) lines.push(`PORT=${port}`);
  else lines[index] = `PORT=${port}`;

  return lines.join("\n") + "\n";
}

function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;

  writeFileSync(temp, text);
  renameSync(temp, file);
}

export function readPorts(stateDir: string): Map<string, number> {
  const ports = new Map<string, number>();

  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, PORTS_FILE), "utf8"));

    for (const [folder, port] of Object.entries(parsed ?? {})) {
      if (isAbsolute(folder) && Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535) ports.set(folder, Number(port));
    }
  } catch {
    return new Map();
  }

  return ports;
}

export function writePort(stateDir: string, folder: string, port: number): void {
  writeAtomic(join(stateDir, PORTS_FILE), JSON.stringify(Object.fromEntries(readPorts(stateDir).set(folder, port))));
}

export function readSelected(stateDir: string): string | undefined {
  try {
    const folder = readFileSync(join(stateDir, SELECTED_FILE), "utf8").trim();

    return folder !== "" && isAbsolute(folder) ? folder : undefined;
  } catch {
    return undefined;
  }
}

export function writeSelected(stateDir: string, folder: string): void {
  writeAtomic(join(stateDir, SELECTED_FILE), folder);
}

export interface DevDeps {
  env: Record<string, string | undefined>;
  home: string;
  stateDir: string | undefined;
  run: Run;
  isFree?: IsFree;
}

export function devStarter(deps: DevDeps): ((folder: string) => Promise<RunResult>) | undefined {
  const dev = loadDev(deps.env, deps.home);
  const { stateDir } = deps;

  if (dev === undefined || stateDir === undefined) return undefined;

  const isFree = deps.isFree ?? realIsFree;

  return async (folder) => {
    if (!isAbsolute(folder)) return { ok: false, message: "no folder for this row" };

    try {
      const ports = readPorts(stateDir);
      const recorded = ports.get(folder);
      const taken = new Set([...ports].flatMap(([other, port]) => (other === folder ? [] : [port])));
      const reuse = recorded !== undefined && !taken.has(recorded) && (await isFree(recorded));
      const port = reuse ? recorded : await pickPort(dev.portMin, dev.portMax, taken, isFree);

      if (port === undefined) return { ok: false, message: "dev server: no free port in range" };

      const file = join(folder, dev.envFile);
      let text = "";

      try {
        text = readFileSync(file, "utf8");
      } catch {
        void 0;
      }

      writeFileSync(file, setPort(text, port));
      writePort(stateDir, folder, port);

      const opened = openPane(deps.env, folder, ["env", `PORT=${port}`, ...dev.command], deps.run);

      return opened.ok ? opened : { ok: false, message: `dev server: ${opened.message}` };
    } catch (error) {
      return { ok: false, message: `dev server: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
