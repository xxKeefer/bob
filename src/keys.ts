export const KEY = { up: "up", down: "down", quit: "quit", enter: "enter" } as const;

export type Key = (typeof KEY)[keyof typeof KEY];

export interface KeyInput {
  setRawMode?: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => void;
}

const SEQUENCES: readonly { sequence: string; key: Key }[] = [
  { sequence: "\x1b[A", key: KEY.up },
  { sequence: "\x1b[B", key: KEY.down },
  { sequence: "\x1bOA", key: KEY.up },
  { sequence: "\x1bOB", key: KEY.down },
  { sequence: "j", key: KEY.down },
  { sequence: "k", key: KEY.up },
  { sequence: "\r", key: KEY.enter },
  { sequence: "\n", key: KEY.enter },
  { sequence: "q", key: KEY.quit },
  { sequence: "\x03", key: KEY.quit },
];

export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let position = 0;

  while (position < chunk.length) {
    const match = SEQUENCES.find((candidate) => chunk.startsWith(candidate.sequence, position));

    if (match === undefined) position += 1;
    else {
      keys.push(match.key);
      position += match.sequence.length;
    }
  }

  return keys;
}

export function attachKeys(input: KeyInput, onKeys: (keys: Key[]) => void): () => void {
  const onData = (chunk: Buffer | string) => onKeys(parseKeys(String(chunk)));

  input.setRawMode?.(true);
  input.resume();
  input.on("data", onData);

  return () => {
    input.off("data", onData);
    input.setRawMode?.(false);
    input.pause();
  };
}
