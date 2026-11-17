// Terminal helpers, the loading animation, and the UI's shared state. Used by
// ui-line.ts and ui-transcript.ts. This is a plain module, not an extension, so
// it isn't reloaded live: restart rude after changing it.
import { relative } from "node:path";
import { Markdown } from "./markdown.ts";

export type Step = { id: string; title: string; body?: string; error?: boolean; use?: { name: string; input: any } };
export type Turn = {
  start: number;
  steps: Step[];
  activity: string;
  blocks: { type: string; text: string }[]; // the response being streamed
  work: { steps: Step[]; think: number; since: number }; // since the last reply text, for the summary line
};
/** How a tool call looks. See ui/tool. */
export type ToolView = {
  title: string;
  verb?: string;
  lines?: string[];
  quiet?: boolean;
  did?: { verb: string; what: string; noun: string };
};

// State lives on globalThis so a reload of this file mid-turn picks it up.
export const S = ((globalThis as any).rudeUI ??= {
  turn: null as Turn | null,
  text: "", // the unfinished last line of streamed reply text
  stream: "", // type of the last delta
  md: new Markdown(),
  compacting: false,
  live: 0, // rows the live region occupies on screen
  alt: false, // the transcript is showing (alternate screen)
  held: [] as string[], // lines printed while the transcript covered the screen
  scroll: 0, // transcript: rows up from the bottom
  closed: null as null | (() => void),
  timer: null as any,
  onKey: null as null | ((s: string, k: any) => void),
  hooked: false,
  blank: true, // the last line printed was blank
  cache: new Map<string, string[]>(),
});

export const tty = !!process.stdout.isTTY;
export const PAD = "  ";
export const BOTTOM = 1; // blank rows kept under the prompt and the status, off the bottom edge
export const cols = () => process.stdout.columns || 80;
export const rows = () => process.stdout.rows || 24;
export const textWidth = () => Math.max(20, Math.min(cols() - 2 * PAD.length, 100));
export const write = (s: string) => process.stdout.write(s);
export const pad = (l: string) => (l ? PAD + l : "");
export const SYNC = ["\x1b[?2026h", "\x1b[?2026l"]; // synchronized output: no tearing
// Synchronized updates nest, so a group of prints can go to the screen as one frame.
let syncDepth = 0;
export const begin = () => { if (!syncDepth++) write(SYNC[0]); };
export const end = () => { if (!--syncDepth) write(SYNC[1]); };
export const HIDE = "\x1b[?25l", SHOW = "\x1b[?25h";
export const plain = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
export const isBlank = (l: string) => !plain(l).trim();
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

export const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};
export const toText = (c: any) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("\n") : String(c));

// -- the loading animation ----------------------------------------------------

const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || process.env.TERM_PROGRAM === "ghostty";
function paint([r, g, b]: number[], s: string) {
  if (truecolor) return `\x1b[38;2;${r | 0};${g | 0};${b | 0}m${s}\x1b[39m`;
  const q = (v: number) => Math.round((v / 255) * 5);
  return `\x1b[38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m${s}\x1b[39m`;
}
function hue(h: number, s = 0.7, l = 0.68) {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

// A sine wave scrolling through four braille cells (8×4 dots), its colour drifting.
const DOT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]];
export function spinner(t: number) {
  const amp = 1.5 * (0.75 + 0.25 * Math.sin(t / 700)); // it breathes
  const y = (x: number) => Math.round(1.5 + amp * Math.sin(x * 0.8 - t / 110));
  let out = "";
  for (let c = 0; c < 4; c++) {
    let bits = 0;
    for (let d = 0; d < 2; d++) {
      const x = c * 2 + d, a = y(x), b = x ? y(x - 1) : a; // join to the previous column
      for (let r = Math.min(a, b); r <= Math.max(a, b); r++) bits |= DOT[d][Math.max(0, Math.min(3, r))];
    }
    out += paint(hue(200 + 60 * Math.sin(t / 1500) + c * 22), String.fromCharCode(0x2800 + bits));
  }
  return out;
}

// A highlight sweeping across the label.
export function shimmer(text: string, t: number) {
  const p = ((t / 45) % (text.length + 16)) - 8;
  const tint = hue(200 + 60 * Math.sin(t / 1500), 0.5, 0.85);
  return [...text].map((ch, i) => {
    const k = Math.max(0, 1 - Math.abs(i - p) / 5) ** 2;
    return paint([0, 1, 2].map((j) => 150 + (tint[j] - 150) * k), ch);
  }).join("");
}

