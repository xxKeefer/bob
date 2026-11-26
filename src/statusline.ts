import { loadRows } from "./rows.ts";

export function statusline(stateDir: string | undefined, now: number, self: string | undefined): string {
  if (stateDir === undefined) return "\n";

  const count = loadRows(stateDir, now).filter((row) => row.status === "waiting" && row.sessionId !== self).length;

  return count === 0 ? "\n" : `${count} waiting\n`;
}

interface Payload {
  session_id?: string;
}

function idOf(text: string): string | undefined {
  try {
    const payload: Payload = JSON.parse(text) ?? {};
    const id = String(payload.session_id ?? "");

    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

export function readSessionId(input: NodeJS.ReadableStream, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let text = "";

    const finish = (id: string | undefined) => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onEnd);
      input.pause();
      resolve(id);
    };

    const onData = (chunk: string | Buffer) => {
      text += chunk.toString();

      const id = idOf(text);

      if (id !== undefined) finish(id);
    };

    const onEnd = () => finish(idOf(text));
    const timer = setTimeout(() => finish(idOf(text)), timeoutMs);

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
  });
}
