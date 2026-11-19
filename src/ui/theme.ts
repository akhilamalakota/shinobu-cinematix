import type { SourceId } from "../sources/types";

export const COLOR = {
  accent: "#DC143C",
  text: "#F2F2F2",
  alt: "#A6A0A2",
  good: "#86D6A2",
  warn: "#F0C560",
  bad: "#FF526B",
  bright: "#FF334F",
} as const;

export const ICON = {
  done: "✓",
  error: "✗",
  pending: "·",
  pointer: "❯",
  dot: "·",
  warn: "⚠",
  bar: "▌",
  down: "↓",
  up: "↑",
  peer: "•",
  pause: "⏸",
} as const;

export const RULE = "#54202B";

export const GUTTER = 2;

export const SOURCE_STYLE: Record<SourceId, { tag: string; color: string }> = {
  fitgirl: { tag: "FG", color: "#a78bfa" },
  yts: { tag: "YTS", color: COLOR.good },
  eztv: { tag: "EZTV", color: COLOR.warn },
  nyaa: { tag: "NYAA", color: "#d8b4fe" },
  subsplease: { tag: "SUB", color: "#b9a7e6" },
  "tpb-movies": { tag: "TPB", color: "#5fd0c5" },
  "tpb-tv": { tag: "TPB", color: "#5fd0c5" },
  bittorrented: { tag: "BT", color: "#7db8f0" },
};

export function sourceStyle(id?: SourceId): { tag: string; color: string } {
  const s = id ? (SOURCE_STYLE as Record<string, { tag: string; color: string }>)[id] : undefined;
  return s ?? { tag: "•", color: COLOR.alt };
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

export const ACCENT_RAMP: readonly [string, string] = [COLOR.accent, COLOR.bright];