// Markdown to ANSI, one source line at a time so it can render while streaming,
// plus the width-aware text helpers the UI needs. Not an extension (it lives in
// a subdirectory, so it isn't auto-loaded); ui-line.ts imports it.

const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const italic = sgr("3", "23");
export const under = sgr("4", "24");
export const strike = sgr("9", "29");
const fg = (n: number) => sgr(`38;5;${n}`, "39");
export const red = fg(167), green = fg(108), grey = fg(244), accent = fg(110);
const code = fg(180), heading = fg(111), link = fg(75);

export const width = (s: string) => Bun.stringWidth(s);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** Split at visible width `w`. Escape codes stay with the part they're in. */
export function cut(s: string, w: number): [string, string] {
  let i = 0, used = 0;
  while (i < s.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m) { i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = Bun.stringWidth(ch);
    if (used + cw > w) break;
    used += cw;
    i += ch.length;
  }
  return [s.slice(0, i), s.slice(i)];
}

/** Truncate to visible width `w`, with an ellipsis if anything was cut. */
export const fit = (s: string, w: number) => (width(s) <= w ? s : cut(s, Math.max(0, w - 1))[0] + "\x1b[0m…");

/**
 * Word-wrap to width `w`. `first` and `rest` are the prefixes of the first and
 * following lines (counted in the width). Styles open at a line break are
 * closed at the end of the line and reopened after the next prefix, so
 * prefixes never pick up an underline or a colour.
 */
export function wrap(s: string, w: number, first = "", rest = " ".repeat(width(first))): string[] {
  const lines: string[] = [];
  let active = ""; // SGR codes seen since the last full reset
  let line = first, used = width(first), empty = true;
  const track = (piece: string) => {
    for (const m of piece.matchAll(/\x1b\[[0-9;]*m/g)) active = m[0] === "\x1b[0m" ? "" : active + m[0];
  };
  const breakLine = () => {
    lines.push(active ? line + "\x1b[0m" : line);
    line = rest + active; used = width(rest); empty = true;
  };
  for (let word of s.split(/ +/)) {
    if (!word) continue;
    let ww = width(word);
    if (!empty && used + 1 + ww > w) breakLine();
    else if (!empty) { line += " "; used++; }
    while (used + ww > w && w - used > 0) { // a word longer than the line: hard break
      const [head, tail] = cut(word, w - used);
      if (!head) break;
      line += head; track(head); empty = false;
      breakLine();
      word = tail; ww = width(word);
    }
    line += word; track(word); used += ww;
    if (ww) empty = false;
  }
  lines.push(active ? line + "\x1b[0m" : line);
  return lines;
}

function inline(s: string): string {
  const held: string[] = []; // code spans, kept away from the other rules
  const hold = (x: string) => `\0${held.push(x) - 1}\0`;
  s = s.replace(/(`+)(.+?)\1/g, (_, __, c) => hold(code(c)));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => hold(t === u ? link(under(u)) : link(under(t)) + dim(` ${u}`)));
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => bold(a ?? b));
  s = s.replace(/(^|[^\w*])\*(?![\s*])(.+?)(?<!\s)\*(?![\w*])/g, (_, p, t) => p + italic(t));
  s = s.replace(/(^|[^\w])_(?![\s_])(.+?)(?<!\s)_(?!\w)/g, (_, p, t) => p + italic(t));
  s = s.replace(/~~(.+?)~~/g, (_, t) => strike(t));
  return s.replace(/\0(\d+)\0/g, (_, i) => held[+i]);
}

/** A streaming markdown renderer. It only remembers whether it is inside a code fence. */
export class Markdown {
  fence: string | null = null;

  /** Render one source line (no newline) into display lines at most `w` wide. */
  line(src: string, w: number): string[] {
    src = src.replace(/\t/g, "  ");
    const f = src.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (f && (!this.fence || f[1].startsWith(this.fence))) {
      const opening = !this.fence;
      this.fence = opening ? f[1] : null;
      return opening && f[2] ? [grey(f[2])] : [];
    }
    if (this.fence) return [grey("│ ") + code(fit(src, w - 2))];
    if (!src.trim()) return [""];

    let m;
    if ((m = src.match(/^\s*(#{1,6})\s+(.*?)\s*#*$/))) return wrap(bold(heading(inline(m[2]))), w);
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(src)) return [grey("─".repeat(Math.min(w, 48)))];
    if ((m = src.match(/^\s*>\s?(.*)/))) return wrap(italic(inline(m[1])), w, grey("│ "));
    if ((m = src.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)/))) {
      const [, lead, marker, task, text] = m;
      const mark = task ? (task[1] === " " ? "☐" : "☑") : /\d/.test(marker) ? marker : "•";
      return wrap(inline(text), w, lead + grey(mark) + " ");
    }
    if (/^\s*\|/.test(src)) {
      if (/^[\s|:-]+$/.test(src)) return [grey(fit(src.replace(/-/g, "─"), w))];
      return [fit(inline(src).replace(/\|/g, grey("│")), w)];
    }
    const lead = src.match(/^\s*/)![0];
    return wrap(inline(src.trim()), w, lead);
  }

  /** Render without changing state: for the unfinished last line of a stream. */
  peek(src: string, w: number): string[] {
    const f = this.fence;
    try { return this.line(src, w); } finally { this.fence = f; }
  }

  /** Render a whole document. */
  static render(text: string, w: number): string[] {
    const md = new Markdown();
    return text.split("\n").flatMap((l) => md.line(l, w));
  }
}
