export const Multiplexers = { tmux: "tmux", zellij: "zellij", none: "" } as const;

export type Multiplexer = (typeof Multiplexers)[keyof typeof Multiplexers];

export function toMultiplexer(value: string): Multiplexer {
  if (value === Multiplexers.tmux || value === Multiplexers.zellij) return value;

  return Multiplexers.none;
}
