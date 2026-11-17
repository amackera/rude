// A small line editor for the prompt, in place of readline: it draws the input
// itself, so long input wraps at word boundaries and every row lines up under the
// first. Shift-Enter and pasted newlines make multi-line messages. Not an
// extension; ui-line.ts drives it with keypresses.

const W = (s: string) => Bun.stringWidth(s);
const seg = new Intl.Segmenter();
/** Grapheme boundaries in s, as indices, including 0 and s.length. */
const bounds = (s: string) => [...[...seg.segment(s)].map((g) => g.index), s.length];

export type Tab = { del: number; ins: string; hint?: string } | { hint: string } | "transcript" | void;

export type EditorOpts = {
  prompt: string; // drawn before the first row (may be styled)
  width: () => number; // columns available for text on each row
  history: string[]; // newest first; a sent message is added
  initial?: string;
  tab?: (before: string) => Tab; // text before the cursor → an edit and/or a hint
  typed?: (before: string) => { del: number; ins: string } | void; // after each typed key, e.g. :coffee: → ☕
  write: (s: string) => void;
};

export type Result = { text: string; rows: number } | null | "transcript";

/** Rows of one logical line, as [start, end) indices: break after the last space that fits, else mid-word. */
function layout(line: string, w: number): [number, number][] {
  const rows: [number, number][] = [];
  let start = 0, col = 0, brk = -1; // brk: index just after the last space on this row
  const b = bounds(line);
  for (let i = 0; i < b.length - 1; i++) {
    const g = line.slice(b[i], b[i + 1]), gw = W(g);
    if (col + gw > w && b[i] > start && g !== " ") {
      const at = brk > start ? brk : b[i];
      rows.push([start, at]);
      start = at;
      col = W(line.slice(start, b[i]));
      brk = -1;
    }
    col += gw;
    if (g === " ") brk = b[i + 1];
  }
  rows.push([start, line.length]);
  return rows;
}

export class Editor {
  text: string;
  cursor: number;
  hint = "";
  pasting = false;
  private drawnRow = 0; // the screen row of the cursor, counted from the first input row
  private hist = -1; // -1: editing the draft; otherwise an index into history
  private draft = "";
  private done!: (r: Result) => void;
  readonly result: Promise<Result>;

  constructor(private o: EditorOpts) {
    this.text = o.initial ?? "";
    this.cursor = this.text.length;
    this.result = new Promise((r) => (this.done = r));
    this.render();
  }

  /** Every row on screen: [global start, global end] into text. */
  private rows() {
    const out: [number, number][] = [];
    let base = 0;
    for (const line of this.text.split("\n")) {
      for (const [s, e] of layout(line, this.o.width())) out.push([base + s, base + e]);
      base += line.length + 1;
    }
    return out;
  }

  private where(rows = this.rows()) {
    let r = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i][0] <= this.cursor) r = i;
    return { row: r, col: W(this.text.slice(rows[r][0], this.cursor)) };
  }

  render(final = false) {
    const rows = this.rows(), indent = " ".repeat(W(this.o.prompt));
    const shown = rows.map(([s, e], i) => (i ? indent : this.o.prompt) + this.text.slice(s, e).replace(/\n$/, ""));
    const { row, col } = this.where(rows);
    let out = (this.drawnRow ? `\x1b[${this.drawnRow}A` : "") + "\r\x1b[J" + shown.join("\r\n");
    out += "\r\n" + (final ? "" : this.hint); // the row under the input: blank, or a hint
    if (final) { this.drawnRow = rows.length; this.o.write(out + "\r"); return rows.length; }
    out += `\x1b[${rows.length - row}A\r` + (W(indent) + col ? `\x1b[${W(indent) + col}C` : "");
    this.drawnRow = row;
    this.o.write(out);
    return rows.length;
  }

  private set(text: string, cursor = text.length) { this.text = text; this.cursor = cursor; }
  private insert(s: string) { this.set(this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor), this.cursor + s.length); }
  private prev(i = this.cursor) { const b = bounds(this.text); return b.findLast((x) => x < i) ?? 0; }
  private next(i = this.cursor) { const b = bounds(this.text); return b.find((x) => x > i) ?? this.text.length; }
  private wordLeft() { const m = this.text.slice(0, this.cursor).match(/\S+\s*$/); return m ? this.cursor - m[0].length : this.prev(); }
  private wordRight() { const m = this.text.slice(this.cursor).match(/^\s*\S+/); return m ? this.cursor + m[0].length : this.next(); }
  private lineStart() { return this.text.lastIndexOf("\n", this.cursor - 1) + 1; }
  private lineEnd() { const i = this.text.indexOf("\n", this.cursor); return i === -1 ? this.text.length : i; }

  /** Move up or down a screen row, keeping the column. False if already at the top or bottom. */
  private vertical(dir: -1 | 1) {
    const rows = this.rows(), { row, col } = this.where(rows), t = row + dir;
    if (t < 0 || t >= rows.length) return false;
    const [s, e] = rows[t];
    let i = s;
    while (i < e && this.text[i] !== "\n" && W(this.text.slice(s, this.next(i))) <= col) i = this.next(i);
    this.cursor = i;
    return true;
  }

  private history(dir: 1 | -1) { // 1: older
    const h = this.o.history, to = this.hist + dir;
    if (to < -1 || to >= h.length) return;
    if (this.hist === -1) this.draft = this.text;
    this.hist = to;
    this.set(to === -1 ? this.draft : h[to]);
  }

  private finish(r: Result) { this.done(r); }

  /** Handle one keypress. `newline` marks Shift-Enter (decoded by the caller). */
  key(s: string | undefined, k: any, newline = false) {
    const name = k?.name, ctrl = !!k?.ctrl, meta = !!k?.meta;
    const hadHint = !!this.hint;
    if (name !== "tab") this.hint = "";
    if (name === "paste-start") { this.pasting = true; return; }
    if (name === "paste-end") { this.pasting = false; return this.render(); }

    if (newline || (name === "return" && this.pasting)) this.insert("\n");
    else if (name === "return" || name === "enter") {
      const text = this.text;
      if (text.trim() && this.o.history[0] !== text) this.o.history.unshift(text);
      this.cursor = text.length; this.hint = "";
      const rows = this.render(true);
      return this.finish({ text, rows });
    }
    else if (ctrl && name === "c") { if (!this.text) return this.finish(null); this.set(""); }
    else if (ctrl && name === "d") { if (!this.text) return this.finish(null); this.set(this.text.slice(0, this.cursor) + this.text.slice(this.next()), this.cursor); }
    else if (name === "tab") {
      const t = this.o.tab?.(this.text.slice(0, this.cursor));
      if (t === "transcript") return this.finish("transcript");
      if (t && "del" in t) { this.set(this.text.slice(0, this.cursor - t.del) + t.ins + this.text.slice(this.cursor), this.cursor - t.del + t.ins.length); }
      this.hint = t?.hint ?? "";
      if (!t && !hadHint) return;
    }
    else if (name === "backspace" && (meta || ctrl)) { const w = this.wordLeft(); this.set(this.text.slice(0, w) + this.text.slice(this.cursor), w); }
    else if (name === "backspace") { const p = this.prev(); this.set(this.text.slice(0, p) + this.text.slice(this.cursor), p); }
    else if (name === "delete") this.set(this.text.slice(0, this.cursor) + this.text.slice(this.next()), this.cursor);
    else if (ctrl && name === "w") { const w = this.wordLeft(); this.set(this.text.slice(0, w) + this.text.slice(this.cursor), w); }
    else if (ctrl && name === "u") { const a = this.lineStart(); this.set(this.text.slice(0, a) + this.text.slice(this.cursor), a); }
    else if (ctrl && name === "k") this.set(this.text.slice(0, this.cursor) + this.text.slice(this.lineEnd()), this.cursor);
    else if ((meta && (name === "left" || name === "b")) || (ctrl && name === "left")) this.cursor = this.wordLeft();
    else if ((meta && (name === "right" || name === "f")) || (ctrl && name === "right")) this.cursor = this.wordRight();
    else if (name === "left" || (ctrl && name === "b")) this.cursor = this.prev();
    else if (name === "right" || (ctrl && name === "f")) this.cursor = this.next();
    else if (name === "home" || (ctrl && name === "a")) this.cursor = this.lineStart();
    else if (name === "end" || (ctrl && name === "e")) this.cursor = this.lineEnd();
    else if (name === "up" || (ctrl && name === "p")) { if (!this.vertical(-1)) this.history(1); }
    else if (name === "down" || (ctrl && name === "n")) { if (!this.vertical(1)) this.history(-1); }
    else if (s && !ctrl && !meta && W(s) > 0 && !/[\x00-\x1f\x7f]/.test(s)) {
      this.insert(s);
      const t = !this.pasting && this.o.typed?.(this.text.slice(0, this.cursor));
      if (t) this.set(this.text.slice(0, this.cursor - t.del) + t.ins + this.text.slice(this.cursor), this.cursor - t.del + t.ins.length);
    }
    else if (!hadHint) return; // nothing changed
    this.render();
  }
}
