// Terminal UI. Replies render as markdown into the scrollback. Everything else
// a turn does (thinking, tool calls, their output) stays in a small live region
// at the bottom that is redrawn in place. Tab cycles how much of it you see:
// quiet → the current step → the whole transcript (full screen) → quiet.
// Tab at an empty prompt opens the transcript too.
//
// It only watches: streamed text via stream-delta, and the rest via advice on
// prompt, run-tool, compact and append-entry.
import type { Rude, Entry } from "../core.ts";
import { createInterface, emitKeypressEvents } from "node:readline";
import { relative, basename } from "node:path";
import { Markdown, wrap, fit, width, bold, dim, italic, red, green, grey, accent } from "./ui/markdown.ts";

type Step = { id: string; title: string; body?: string; error?: boolean; use?: { name: string; input: any } };
type Turn = {
  start: number;
  steps: Step[];
  activity: string;
  blocks: { type: string; text: string }[]; // the response being streamed
  work: { steps: Step[]; think: number; since: number }; // since the last reply text, for the summary line
};

// State lives on globalThis so a reload of this file mid-turn picks it up.
const S = ((globalThis as any).rudeUI ??= {
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

const tty = !!process.stdout.isTTY;
const PAD = "  ";
const BOTTOM = 1; // blank rows kept under the prompt and the status, off the bottom edge
const cols = () => process.stdout.columns || 80;
const rows = () => process.stdout.rows || 24;
const textWidth = () => Math.max(20, Math.min(cols() - 2 * PAD.length, 100));
const write = (s: string) => process.stdout.write(s);
const pad = (l: string) => (l ? PAD + l : "");
const SYNC = ["\x1b[?2026h", "\x1b[?2026l"]; // synchronized output: no tearing
// Synchronized updates nest, so a group of prints can go to the screen as one frame.
let syncDepth = 0;
const begin = () => { if (!syncDepth++) write(SYNC[0]); };
const end = () => { if (!--syncDepth) write(SYNC[1]); };
const HIDE = "\x1b[?25l", SHOW = "\x1b[?25h";
const plain = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const isBlank = (l: string) => !plain(l).trim();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// -- output -------------------------------------------------------------------

function clearLive() {
  if (!S.live) return;
  write(`\r${S.live > 1 ? `\x1b[${S.live - 1}A` : ""}\x1b[J`);
  S.live = 0;
}

function drawLive() {
  if (!tty || !S.turn || S.alt) return;
  const lines = liveLines().slice(-(rows() - 1)).map((l) => fit(l, cols() - 1) + "\x1b[0m");
  write(lines.join("\n"));
  S.live = lines.length;
}

function redraw() {
  if (!tty) return;
  if (S.alt) return drawTranscript();
  begin(); clearLive(); drawLive(); end();
}

/** Print lines into the scrollback, above the live region. Runs of blank lines collapse. */
function print(lines: string[]) {
  const keep: string[] = [];
  for (const l of lines) {
    const blank = isBlank(l);
    if (blank && S.blank) continue;
    S.blank = blank;
    keep.push(blank ? "" : l);
  }
  if (!keep.length) return;
  if (S.alt) return void S.held.push(...keep);
  if (!tty) return void write(keep.map(plain).join("\n") + "\n");
  begin(); clearLive();
  write(keep.join("\n") + "\n");
  drawLive(); end();
}

const say = (text: string) => print(text.split("\n").map(pad));

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
function spinner(t: number) {
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
function shimmer(text: string, t: number) {
  const p = ((t / 45) % (text.length + 16)) - 8;
  const tint = hue(200 + 60 * Math.sin(t / 1500), 0.5, 0.85);
  return [...text].map((ch, i) => {
    const k = Math.max(0, 1 - Math.abs(i - p) / 5) ** 2;
    return paint([0, 1, 2].map((j) => 150 + (tint[j] - 150) * k), ch);
  }).join("");
}

// -- the live region ----------------------------------------------------------

const describe = (u: { name: string; input: any }) => {
  if (u.name === "bash") return `$ ${String(u.input.command).trim().split("\n")[0]}`;
  const p = u.input?.path && rel(u.input.path);
  if (u.name === "edit") return `${u.input.old_string === "" ? "create" : "edit"} ${p}`;
  return `${u.name} ${p ?? JSON.stringify(u.input)}`;
};
// One calm word for the status line; the details are a Tab away.
const doing = (u: { name: string }) => ({ bash: "running", edit: "editing" } as Record<string, string>)[u.name] ?? u.name;
const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};

// The label holds for a moment before changing, so quick tool calls don't flicker.
const HOLD = 900;
let shown = { label: "", since: 0 };

function status() {
  const t = S.turn!, now = Date.now();
  if (t.activity !== shown.label && (now - shown.since > HOLD || !shown.label)) shown = { label: t.activity, since: now };
  const hint = S.alt ? "" : "tab to expand";
  const meta = [elapsed(now - t.start), t.steps.length ? plural(t.steps.length, "step") : "", hint].filter(Boolean);
  return PAD + spinner(now) + "  " + shimmer(shown.label, now) + "  " + grey(meta.join(" · "));
}

function liveLines() {
  const w = textWidth();
  const out: string[] = [];
  if (S.text && !S.compacting) out.push(...S.md.peek(S.text, w).map(pad));
  // The bottom looks like it does at the prompt: a blank, the rule, then the status where the prompt was.
  if (out.length ? !isBlank(out.at(-1)!) : !S.blank) out.push("");
  out.push(ruleLine(), status(), ...Array(BOTTOM).fill(""));
  return out;
}

function tick() {
  if (S.alt) drawTranscript();
  else redraw();
}

function startTurn(activity: string) {
  S.turn = { start: Date.now(), steps: [], activity, blocks: [], work: { steps: [], think: 0, since: 0 } };
  shown = { label: "", since: 0 };
  S.text = ""; S.stream = ""; S.md = new Markdown();
  if (tty) write(HIDE);
  print([""]);
  if (tty) {
    clearInterval(S.timer);
    S.timer = setInterval(tick, 50);
  }
  keys(turnKey);
  redraw();
}

// Work between replies shows inline as one quiet line: "▸ thought 4s · ran bun test · edited core.ts".
function endThinking() {
  const w = S.turn?.work;
  if (w?.since) { w.think += Date.now() - w.since; w.since = 0; }
}

function flushWork() {
  const t = S.turn;
  if (!t) return;
  endThinking();
  const { steps, think } = t.work;
  t.work = { steps: [], think: 0, since: 0 };
  const parts: string[] = [];
  if (think) parts.push(think < 1000 ? "thought briefly" : `thought ${elapsed(think)}`);
  const cmds = steps.filter((s) => s.use?.name === "bash");
  if (cmds.length === 1) parts.push(`ran ${fit(String(cmds[0].use!.input.command).trim().split("\n")[0], 48)}`);
  else if (cmds.length) parts.push(`ran ${cmds.length} commands`);
  const files = [...new Set(steps.filter((s) => s.use?.name === "edit").map((s) => basename(String(s.use!.input.path))))];
  if (files.length) parts.push(`edited ${files.length > 3 ? plural(files.length, "file") : files.join(", ")}`);
  const others = new Map<string, number>();
  for (const s of steps) if (s.use && !["bash", "edit"].includes(s.use.name)) others.set(s.use.name, (others.get(s.use.name) ?? 0) + 1);
  for (const [name, n] of others) parts.push(n > 1 ? `${name} ×${n}` : name);
  const failed = steps.filter((s) => s.error).length;
  if (!parts.length) return;
  print(["", PAD + grey("▸ " + parts.join(" · ")) + (failed ? grey(" · ") + red(`${failed} failed`) : "")]);
}

async function endTurn() {
  flushText();
  flushWork();
  const t = S.turn!;
  clearInterval(S.timer);
  if (S.alt) { // they're reading; finish when they close it
    drawTranscript();
    await new Promise<void>((r) => (S.closed = r));
  }
  keys(null);
  if (tty) { begin(); clearLive(); end(); } // the cursor stays hidden until the next prompt is drawn
  S.turn = null;
  print(["", PAD + grey(`· ${elapsed(Date.now() - t.start)}`)]);
}

// Streamed reply text goes to the scrollback a whole line at a time.
function pushText(s: string) {
  S.text += s;
  let i;
  while ((i = S.text.indexOf("\n")) !== -1) {
    const line = S.text.slice(0, i);
    S.text = S.text.slice(i + 1);
    print(S.md.line(line, textWidth()).map(pad));
  }
}

function flushText() {
  if (S.text) print(S.md.line(S.text, textWidth()).map(pad));
  S.text = "";
  S.md = new Markdown();
}

// -- keys ---------------------------------------------------------------------

function keys(handler: typeof S.onKey) {
  if (!process.stdin.isTTY) return;
  S.onKey = handler;
  if (!handler) { process.stdin.setRawMode(false); process.stdin.pause(); return; }
  emitKeypressEvents(process.stdin);
  if (!S.hooked) {
    S.hooked = true;
    process.stdin.on("keypress", (s: string, k: any) => S.onKey?.(s, k));
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

let cancel = () => {};

function turnKey(_s: string, k: any) {
  if (k?.ctrl && k.name === "c") return cancel();
  if (S.alt) return pagerKey(k);
  if (k?.name === "tab") openTranscript();
}

// -- the transcript -----------------------------------------------------------

function openTranscript() {
  S.alt = true; S.scroll = 0;
  write("\x1b[?1049h\x1b[?25l");
  drawTranscript();
}

function closeTranscript() {
  S.alt = false;
  write("\x1b[?1049l" + (S.turn && S.closed === null ? "" : "\x1b[?25h"));
  const held = S.held.splice(0);
  if (held.length) print(held); else redraw();
  S.closed?.(); S.closed = null;
}

// ↑↓ jump a step (a message, thinking, a reply or a tool call); j k scroll a line.
function pagerKey(k: any) {
  if (!k) return;
  if (["tab", "q", "escape"].includes(k.name) || (k.ctrl && k.name === "c")) return closeTranscript();
  const page = rows() - 4;
  const by: Record<string, number> = { k: 1, j: -1, pageup: page, b: page, pagedown: -page, space: -page, home: 1e9, g: 1e9, end: -1e9 };
  const name = k.name === "g" && k.shift ? "end" : k.name;
  if (name === "up" || name === "down") {
    const { lines, steps } = transcriptLines(textWidth());
    const max = Math.max(0, lines.length - (rows() - 3));
    const top = max - S.scroll;
    const to = name === "up" ? steps.findLast((i) => i < top) ?? 0 : steps.find((i) => i > top) ?? max;
    S.scroll = max - Math.min(to, max);
  } else if (name in by) S.scroll += by[name];
  else return;
  drawTranscript();
}

function drawTranscript() {
  const w = textWidth();
  const { lines } = transcriptLines(w);
  const running = S.turn && S.closed === null;
  const view = rows() - (running ? 4 : 3);
  const max = Math.max(0, lines.length - view);
  S.scroll = Math.max(0, Math.min(S.scroll, max));
  const top = max - S.scroll;
  const shown = lines.slice(top, top + view);
  while (shown.length < view) shown.push("");
  const where = max ? (S.scroll ? `${Math.round((top / max) * 100)}%` : "end") : "all";
  const help = grey(`transcript · ${where} · ↑↓ steps · j k lines · pgup pgdn · g G · tab to collapse`);
  const body = ["", ...shown, ...(running ? [status()] : [""]), PAD + help].map((l) => fit(l, cols() - 1) + "\x1b[0m\x1b[K");
  write(SYNC[0] + "\x1b[H" + body.join("\n") + SYNC[1]);
}

function transcriptLines(w: number) {
  const path: Entry[] = rude_.call("path");
  const results = new Map<string, any>();
  for (const e of path) {
    const c = e.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  }
  const live = new Map<string, Step>((S.turn?.steps ?? []).map((s: Step) => [s.id, s]));
  const out: string[] = [];
  for (const e of path) {
    const key = `${e.id}:${w}`;
    let lines = S.cache.get(key);
    if (!lines) {
      let complete = true;
      lines = entryLines(e, w, (id) => {
        const r = results.get(id);
        if (r) return { body: toText(r.content), error: r.is_error };
        complete = false;
        return live.get(id);
      });
      if (complete) S.cache.set(key, lines);
    }
    out.push(...lines);
  }
  // The response still streaming.
  for (const b of S.turn?.blocks ?? []) out.push(...blockLines(b, w));
  // Each block starts with a STEP marker line: note where, and make it blank.
  const steps: number[] = [];
  out.forEach((l, i) => { if (l === STEP) { out[i] = ""; steps.push(i); } });
  return { lines: out, steps };
}

// Marks the (blank) first line of each block in the transcript, for ↑↓.
const STEP = "\0step";

const toText = (c: any) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("\n") : String(c));

function blockLines(b: { type: string; text: string }, w: number) {
  if (b.type === "thinking") {
    const lines = b.text.trim().split("\n").flatMap((l) => (l.trim() ? wrap(l, w - 2) : [""]));
    return [STEP, ...lines.map((l) => PAD + grey("┊ ") + dim(italic(l))), ""];
  }
  return [STEP, ...Markdown.render(b.text, w).map(pad), ""];
}

function entryLines(e: Entry, w: number, result: (id: string) => Partial<Step> | undefined): string[] {
  if (e.type === "compaction") return [STEP, PAD + grey(`[compacted ~${Math.round(e.tokensBefore / 1000)}k tokens into a summary]`), ""];
  if (e.type !== "message") return [];
  const { role, content } = e.message;
  if (typeof content === "string") {
    return role === "user"
      ? [STEP, ...wrap(bold(content), w, accent("› ")).map(pad), ""]
      : blockLines({ type: "text", text: content }, w);
  }
  const out: string[] = [];
  for (const b of content) {
    if (b.type === "thinking") out.push(...blockLines({ type: "thinking", text: b.thinking }, w));
    else if (b.type === "text" && role === "assistant") out.push(...blockLines(b, w));
    else if (b.type === "text") out.push(...b.text.split("\n").map((l: string) => PAD + grey(l)));
    else if (b.type === "tool_use") out.push(...toolLines(b, result(b.id), w));
  }
  return out;
}

function toolLines(u: any, r: Partial<Step> | undefined, w: number) {
  const mark = !r || r.body === undefined ? accent("›") : r.error ? red("✗") : green("✓");
  const out = [STEP, PAD + mark + " " + bold(describe(u))];
  const ind = PAD + "  ";
  if (u.name === "bash") {
    const more = String(u.input.command).trim().split("\n").slice(1);
    out.push(...more.map((l) => ind + "  " + l));
  } else if (u.name === "edit") {
    const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);
    out.push(...lines(u.input.old_string).map((l) => ind + red(`- ${l}`)));
    out.push(...lines(u.input.new_string).map((l) => ind + green(`+ ${l}`)));
  } else {
    out.push(ind + grey(JSON.stringify(u.input)));
  }
  if (r?.body === undefined) out.push(ind + grey("running…"));
  else if (u.name !== "edit" || r.error) out.push(...r.body.trimEnd().split("\n").map((l) => ind + (r.error ? red(l) : grey(l))));
  return out.map((l) => fit(l, w + PAD.length));
}

// -- the prompt ---------------------------------------------------------------

const history: string[] = [];
const TAB = Symbol("tab");

/** Ask for a line. null means Ctrl-C or Ctrl-D; TAB means Tab on an empty line. */
function ask(q: string): Promise<string | null | typeof TAB> {
  return new Promise((resolve) => {
    let answer: string | null | typeof TAB = null;
    const rl = createInterface({
      input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, history, historySize: 500,
      completer: (line: string) => {
        if (line === "") { answer = TAB; setImmediate(() => rl.close()); }
        return [[], line];
      },
    } as any);
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => resolve(answer));
    rl.question(q, (a) => { answer = a; rl.close(); });
  });
}

// Cached, since the live region redraws every 50ms. Cleared when an entry lands or the width changes.
const ruleLine = (): string => (S.rule ??= rude_.call("ui/prompt-rule"));

/** The rule above the prompt (and above the status during a turn): a grey line with the model and context size at the right. */
function rule() {
  const w = cols() - 2 * PAD.length;
  const last = rude_.call("path").findLast((e: Entry) => e.type === "message" && (e as any).usage);
  const u = (last as any)?.usage;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const used = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0;
  const bits = [(last as any)?.model, used && `${k(used)} context`].filter(Boolean);
  const label = bits.length ? ` ${bits.join(" · ")} ` : "";
  if (width(label) + 4 > w) return PAD + grey("─".repeat(w));
  return PAD + grey("─".repeat(w - width(label) - 2) + label + "──");
}

let rude_: Rude;

export default (rude: Rude) => {
  rude_ = rude;
  cancel = () => rude.call("cancel");
  S.cache.clear();
  // Reloaded mid-turn: the turn was started by the old code, so fill in anything it didn't track.
  if (S.turn) S.turn.work ??= { steps: [], think: 0, since: 0 };
  if (S.turn && tty) { clearInterval(S.timer); S.timer = setInterval(tick, 50); }
  if (S.onKey) S.onKey = turnKey;

  rude.def("stream-delta", ({ type, text }: { type: string; text: string }) => {
    const t = S.turn;
    if (type !== S.stream) {
      if (S.stream === "text") flushText();
      if (S.stream === "thinking") endThinking();
      t?.blocks.push({ type, text: "" });
      S.stream = type;
      if (type === "thinking" && t && !S.compacting) t.work.since = Date.now();
      if (type === "text" && !S.compacting) { flushWork(); print([""]); }
    }
    if (t) {
      t.blocks.at(-1)!.text += text;
      if (!S.compacting) t.activity = type === "thinking" ? "thinking" : "writing";
    }
    if (type === "text" && !S.compacting) pushText(text);
  }, "Show streamed reply text as markdown; thinking goes to the live region and transcript.");

  rude.advise("prompt", "ui-line", async (next, text) => {
    const own = !S.turn;
    if (own) startTurn("thinking");
    try { return await next(text); }
    finally { if (own) await endTurn(); }
  });

  rude.advise("compact", "ui-line", async (next, ...args) => {
    const own = !S.turn;
    if (own) startTurn("compacting");
    const was = S.turn!.activity;
    S.turn!.activity = "compacting";
    S.compacting = true;
    try { return await next(...args); }
    finally {
      S.compacting = false; S.text = ""; S.stream = "";
      if (S.turn) S.turn.blocks = [];
      if (own) await endTurn(); else S.turn!.activity = was;
    }
  });

  rude.advise("run-tool", "ui-line", async (next, use) => {
    const t = S.turn;
    const step: Step = { id: use.id, title: describe(use), use };
    if (t) { t.steps.push(step); t.work.steps.push(step); t.activity = doing(use); }
    try {
      const r = await next(use);
      step.body = toText(r.content);
      step.error = !!r.is_error;
      return r;
    } catch (e: any) {
      step.body = String(e?.message ?? e); step.error = true;
      throw e;
    } finally {
      if (t) t.activity = "thinking";
    }
  });

  rude.advise("append-entry", "ui-line", (next, e) => {
    const entry = next(e);
    S.rule = null;
    if (entry.type === "message" && entry.message.role === "assistant") {
      flushText();
      endThinking();
      S.stream = "";
      if (S.turn) S.turn.blocks = [];
      if (!["tool_use", "end_turn"].includes(entry.stop_reason)) print(["", PAD + red(`[stopped: ${entry.stop_reason}]`)]);
    }
    if (entry.type === "compaction") print(["", PAD + grey(`[compacted ~${Math.round(entry.tokensBefore / 1000)}k tokens into a summary]`)]);
    return entry;
  });

  rude.def("ui/prompt-rule", rule, "The line printed above the prompt: a grey rule labelled with the model and context size.");

  rude.def("main", async (argv: string[]) => {
    if (tty) process.on("exit", () => write((S.alt ? "\x1b[?1049l" : "") + "\x1b[?25h"));
    process.stdout.on("resize", () => { S.rule = null; if (S.turn) redraw(); });
    const args = [...argv];
    const flag = (...names: string[]) => {
      const i = args.findIndex((a) => names.includes(a));
      return i === -1 ? false : (args.splice(i, 1), true);
    };

    if (flag("-c", "--continue")) {
      const [latest] = rude.call("sessions");
      if (latest) open(latest.file);
    } else if (flag("-r", "--resume")) {
      const list = rude.call("sessions").slice(0, 20);
      print(list.map((s: any, i: number) =>
        `${PAD}${grey(String(i + 1).padStart(2))}  ${grey(s.mtime.toLocaleString())}  ${s.title.split("\n")[0].slice(0, 70)}`));
      print([""]);
      const a = await ask(`${PAD}session: `);
      const pick = typeof a === "string" ? list[Number(a) - 1] : undefined;
      if (pick) open(pick.file);
    }

    const p = args.indexOf("-p");
    if (p !== -1) {
      await rude.call("prompt", args.slice(p + 1).join(" "));
      process.exit(0);
    }

    for (;;) {
      // Rule, room underneath and prompt go out as one frame, and the cursor only shows once
      // it's in place, so it doesn't jump around on the way there.
      if (tty) { write(HIDE); begin(); }
      print([""]);
      if (tty) {
        print([rude.call("ui/prompt-rule")]);
        write("\n".repeat(BOTTOM) + `\x1b[${BOTTOM}A`); // room under the prompt
      }
      const asked = ask(PAD + accent("› ")); // draws the prompt before it returns
      if (tty) { end(); write(SHOW); }
      const line = await asked;
      if (line === null) process.exit(0);
      if (tty) write(HIDE);
      if (line === TAB) {
        if (tty) { write("\r\x1b[K\x1b[A\x1b[K"); S.blank = true; } // drop the prompt and rule; both come back after
        await new Promise<void>((r) => { S.closed = r; keys((_s, k) => pagerKey(k)); openTranscript(); });
        keys(null);
        continue;
      }
      if (tty) {
        // Take the rule and prompt back off the screen and print just the message, so the
        // turn's rule and status land exactly where the rule and prompt were.
        const n = Math.max(1, Math.ceil(width(PAD + "› " + line) / cols()));
        begin();
        write(`\x1b[${n + 1}A\r\x1b[J`);
        S.blank = true;
        if (line.trim()) print(wrap(line, textWidth(), accent("› ")).map(pad));
        end();
      } else S.blank = false;
      const text = line.trim();
      if (!text) continue;
      try {
        if (text.startsWith("/")) await command(text);
        else await rude.call("prompt", text);
      } catch (e: any) {
        print(["", PAD + red(String(e?.message ?? e))]);
      }
    }
  }, "Entry point. Flags: -c/--continue, -r/--resume, -p <prompt> (run once and exit).");

  function open(file: string) {
    rude.call("open-session", file);
    const n = rude.call("path").length;
    say(grey(`resumed ${file} (${n} entries on this branch)`));
  }

  async function command(line: string) {
    const [cmd, arg] = line.split(/\s+/);
    print([""]);
    if (cmd === "/new") { rude.call("new-session"); say(grey("new session")); }
    else if (cmd === "/tree") tree();
    else if (cmd === "/branch") {
      const restored = await rude.call("branch", arg ?? null);
      say(grey(`now at ${arg ?? "the root"}`));
      if (Array.isArray(restored) && restored.length) say(grey(`restored files: ${restored.join(", ")}`));
    }
    else if (cmd === "/compact") await rude.call("compact", line.slice(cmd.length).trim());
    else if (cmd === "/session") say(rude.call("session-file") ?? "(nothing written yet)");
    else say(`commands: /new  /tree  /branch <id>  /compact [instructions]  /session`);
  }

  // Print the session tree. Indent only where it branches, so long linear runs stay flat.
  function tree() {
    const all: Entry[] = rude.call("entries");
    const kids = new Map<string | null, Entry[]>();
    for (const e of all) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
    const onPath = new Set(rude.call("path").map((e: Entry) => e.id));
    const out: string[] = [];
    const walk = (parent: string | null, depth: number) => {
      const children = kids.get(parent) ?? [];
      for (const e of children) {
        const text = label(e);
        if (text) out.push(`${PAD}${"  ".repeat(depth)}${onPath.has(e.id) ? accent("*") : " "} ${grey(e.id)} ${text}`);
        walk(e.id, children.length > 1 ? depth + 1 : depth);
      }
    };
    walk(null, 0);
    print(out);
  }

  function label(e: Entry) {
    if (e.type !== "message") return grey(`[${e.type}]`);
    const { role, content } = e.message;
    if (typeof content === "string") return `you: ${content.split("\n")[0].slice(0, 70)}`;
    const text = content.find((b: any) => b.type === "text")?.text;
    const tools = content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
    if (role === "assistant") return text ? `rude: ${text.split("\n")[0].slice(0, 70)}` : tools.length ? grey(`→ ${tools.join(", ")}`) : "";
    return ""; // tool results
  }
};
