export const KEY = { up: "up", down: "down", quit: "quit" } as const;

export type Key = (typeof KEY)[keyof typeof KEY];

const SEQUENCES: [string, Key][] = [
  ["\x1b[A", KEY.up],
  ["\x1b[B", KEY.down],
  ["\x1bOA", KEY.up],
  ["\x1bOB", KEY.down],
  ["j", KEY.down],
  ["k", KEY.up],
  ["q", KEY.quit],
  ["\x03", KEY.quit],
];

export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let position = 0;

  while (position < chunk.length) {
    const match = SEQUENCES.find(([sequence]) => chunk.startsWith(sequence, position));

    if (match === undefined) position += 1;
    else {
      keys.push(match[1]);
      position += match[0].length;
    }
  }

  return keys;
}
