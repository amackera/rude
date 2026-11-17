// Terminal UI. Replies render as markdown into the scrollback. Everything else
// a turn does (thinking, tool calls, their output) stays in a small live region
// at the bottom that is redrawn in place; Tab opens the full transcript
// (ui-transcript.ts). Terminal helpers and shared state are in ui/term.ts.
//
// It only watches: streamed text via stream-delta, and the rest via advice on
// prompt, run-tool, compact and append-entry. Hooks for other extensions:
// command/<name>, ui/tool/<name>, ui/print, ui/say, ui/live, key/<name>.
import type { Rude, Entry } from "../core.ts";
import { createInterface, emitKeypressEvents } from "node:readline";
import { basename } from "node:path";
import { VERBS } from "./ui/verbs.ts";
import { EMOJI, emojiNames, shortcodeEdit } from "./ui/emoji.ts";
import { Editor } from "./ui/editor.ts";
import { Markdown, wrap, fit, width, red, green, grey, accent } from "./ui/markdown.ts";
import {
  S, tty, PAD, BOTTOM, cols, rows, textWidth, write, pad, begin, end, HIDE, SHOW, isBlank, plain, plural, elapsed,
  rel, toText, spinner, shimmer, type Step, type ToolView,
} from "./ui/term.ts";

// -- output -------------------------------------------------------------------

function clearLive() {
  if (!S.live) return;
  write(`\r${S.live > 1 ? `\x1b[${S.live - 1}A` : ""}\x1b[J`);
  S.live = 0;
}

function drawLive() {
  if (!tty || !S.turn || S.alt) return;
  let lines = liveLines();
  // Never shorter than it was: pad above the rule instead, so the status line keeps its row
  // rather than rising and leaving blank rows under it.
  if (lines.length < (S.floor ?? 0)) lines = [...Array(S.floor - lines.length).fill(""), ...lines];
  lines = lines.slice(-(rows() - 1)).map((l) => fit(l, cols() - 1) + "\x1b[0m");
  write(lines.join("\n"));
  S.live = S.floor = lines.length;
}

function redraw() {
  if (!tty) return;
  if (S.alt) return rude_.call("ui/transcript-draw");
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
  S.floor = Math.max(0, (S.floor ?? 0) - keep.length); // those rows now belong to the scrollback
  drawLive(); end();
}

const say = (text: string) => print(text.split("\n").map(pad));

// -- the live region ----------------------------------------------------------

const has = (name: string) => !!rude_.doc(name);
const view = (u: { name: string; input: any }): ToolView => rude_.call("ui/tool-view", u);
const describe = (u: { name: string; input: any }) => view(u).title;
// One calm word for the status line; the details are a Tab away.
const doing = (u: { name: string; input: any }) => view(u).verb ?? u.name;

// The label holds for a moment before changing, so quick tool calls don't flicker.
const HOLD = 900;
let shown = { label: "", since: 0 };
// "thinking" shows as a verb from ui/thinking-verbs, a new one each stretch of thinking.
let verb = "";
const pick = () => {
  const vs: string[] = rude_.call("ui/thinking-verbs");
  return vs.length ? vs[Math.floor(Math.random() * vs.length)] : "thinking";
};

function status() {
  const t = S.turn!, now = Date.now();
  if (t.activity !== "thinking") verb = "";
  const label = t.activity === "thinking" ? (verb ||= pick()) : t.activity;
  if (label !== shown.label && (now - shown.since > HOLD || !shown.label)) shown = { label, since: now };
  const hint = S.alt ? "esc to stop" : "esc to stop · tab to expand";
  const meta = [elapsed(now - t.start), t.steps.length ? plural(t.steps.length, "step") : "", hint].filter(Boolean);
  return PAD + rude_.call("ui/spinner", now) + "  " + shimmer(shown.label, now) + "  " + grey(meta.join(" · "));
}

function liveLines() {
  const w = textWidth();
  const out: string[] = [];
  if (S.text && !S.compacting) out.push(...S.md.peek(S.text, w).map(pad));
  const extra: string[] = rude_.call("ui/live", w);
  if (extra.length) out.push("", ...extra);
  // The bottom looks like it does at the prompt: a blank, the rule, then the status where the prompt was.
  if (out.length ? !isBlank(out.at(-1)!) : !S.blank) out.push("");
  out.push(ruleLine(), rude_.call("ui/status"), ...Array(BOTTOM).fill(""));
  return out;
}

function tick() {
  if (S.alt) rude_.call("ui/transcript-draw");
  else redraw();
}

function startTurn(activity: string) {
  S.turn = { start: Date.now(), steps: [], activity, blocks: [], work: { steps: [], think: 0, since: 0 } };
  shown = { label: "", since: 0 };
  S.text = ""; S.stream = ""; S.md = new Markdown(); S.floor = 0;
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
  // Group by what each tool view says it did ("ran bun test", "edited core.ts"); plain tool names otherwise.
  const groups = new Map<string, { verb: string; noun: string; what: string[]; n: number }>();
  for (const s of steps) {
    if (!s.use) continue;
    const did = view(s.use).did ?? { verb: s.use.name, what: "", noun: "" };
    let g = groups.get(did.verb);
    if (!g) groups.set(did.verb, (g = { verb: did.verb, noun: did.noun, what: [], n: 0 }));
    g.n++;
    if (did.what && !g.what.includes(did.what)) g.what.push(did.what);
  }
  for (const g of groups.values()) {
    const list = g.what.join(", ");
    if (!g.what.length) parts.push(g.n > 1 ? `${g.verb} ×${g.n}` : g.verb);
    else if (g.what.length === 1) parts.push(`${g.verb} ${fit(g.what[0], 48)}`);
    else parts.push(`${g.verb} ${g.what.length <= 3 && width(list) <= 48 ? list : plural(g.what.length, g.noun || "thing")}`);
  }
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
    rude_.call("ui/transcript-draw");
    await new Promise<void>((r) => (S.closed = r));
  }
  keys(null);
  if (tty) { begin(); clearLive(); end(); } // the cursor stays hidden until the next prompt is drawn
  S.floor = 0;
  S.turn = null;
  print(["", PAD + grey(`· ${elapsed(Date.now() - t.start)}`)]);
}

// Streamed reply text goes to the scrollback a whole line at a time.
// S.text must never hold a newline while the live region draws it: the terminal would
// put it on two rows, the region would count one, and the next clear would leave a ghost row.
function pushText(s: string) {
  S.text += s;
  const i = S.text.lastIndexOf("\n");
  if (i === -1) return;
  const done = S.text.slice(0, i).split("\n");
  S.text = S.text.slice(i + 1);
  print(done.flatMap((line) => S.md.line(line, textWidth())).map(pad));
}

function flushText() {
  // Clear S.text before printing: print redraws the live region, which would draw it a second time.
  const text = S.text, md = S.md;
  S.text = "";
  S.md = new Markdown();
  if (text) print(md.line(text, textWidth()).map(pad));
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
  if (!S.escHooked) {
    // Bun holds a lone Esc until the next key arrives (Node flushes it after 500ms), so
    // Esc would do nothing. A chunk that is only ESC is the Esc key: flush it now.
    S.escHooked = true;
    process.stdin.on("data", (d) => {
      if (String(d) !== "\x1b") return;
      const sym = Object.getOwnPropertySymbols(process.stdin).find((x) => x.description === "escape-decoder");
      (process.stdin as any)[sym!]?.next?.("");
    });
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

// A key during a turn calls key/<name>, e.g. key/tab, key/ctrl-c, key/alt-up, if it's defined.
// Bun marks a lone Esc as meta, which would make it "alt-escape".
const keyName = (k: any) => k?.name && `${k.ctrl ? "ctrl-" : ""}${k.meta && k.name !== "escape" ? "alt-" : ""}${k.shift ? "shift-" : ""}${k.name}`;

function turnKey(s: string, k: any) {
  const whole = reassemble(s, k);
  if (whole === "swallow") return;
  const newline = NEWLINE_KEYS.includes(whole ?? k?.sequence);
  if (whole && !newline) return; // some other xterm-encoded key: ignore
  const name = keyName(k);
  if (S.alt && name !== "ctrl-c" && name !== "escape") return rude_.call("ui/transcript-key", k); // those two always stop the turn
  if (!newline && name && has(`key/${name}`)) rude_.call(`key/${name}`);
  else rude_.call("ui/turn-key", s, k, newline); // anything else: typing, by default nowhere
}

// -- the prompt ---------------------------------------------------------------

const history: string[] = [];
const TAB = Symbol("tab");

/** Ask for a line. null means Ctrl-C or Ctrl-D; TAB means Tab on an empty line. */
// Shift-Enter: Ghostty (and others) send CSI 27;2;13~ by default, but under modifyOtherKeys
// Ghostty sends nothing at all. tmux sends a plain CR unless the app asks for modifyOtherKeys,
// then CSI 13;2u. So ask only inside tmux.
const NEWLINE_KEYS = ["\x1b[13;2u", "\x1b[27;2;13~", "\x1b\r"]; // Shift-Enter (CSI u, xterm), Alt-Enter

// Bun's key decoder only knows two-number sequences, so xterm's CSI 27;<mod>;<code>~
// (Ghostty's Shift-Enter) arrives as "ESC[27;2;" then "1", "3", "~". Put it back together.
// Returns "swallow" for the pieces, the whole sequence at the end, or null for other keys.
let csi27: string | null = null;
function reassemble(s: string, k: any): string | "swallow" | null {
  if (csi27 !== null) {
    csi27 += k?.sequence ?? s ?? "";
    if (!csi27.endsWith("~") && csi27.length < 12) return "swallow";
    const whole = "\x1b[27;" + csi27;
    csi27 = null;
    return whole;
  }
  const m = k?.sequence?.match(/^\x1b\[27;(\d+);$/);
  if (m) { csi27 = m[1] + ";"; return "swallow"; }
  return null;
}

const MOK_ON = process.env.TMUX ? "\x1b[>4;1m" : "";
const MOK_OFF = process.env.TMUX ? "\x1b[>4;0m" : "";

let askedRows = 0; // screen rows the last answer took, so the prompt can be taken back off

let editing: Editor | null = null; // the prompt being edited, so a resize can redraw it

/** Ask for a line. null means Ctrl-C or Ctrl-D on an empty line; TAB means Tab on an empty line. */
function ask(q: string): Promise<string | null | typeof TAB> {
  if (!process.stdin.isTTY) return new Promise((resolve) => { // piped input: plain readline
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("close", () => resolve(null));
    rl.question(q, (a) => { askedRows = 1; rl.close(); resolve(a); });
  });
  const shortcode = /(^|[^\w:]):([a-z0-9_+-]+)$/;
  const common = (xs: string[]) => xs.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });
  const ed: Editor = new Editor({
    prompt: q,
    // Rows end where replies do: the reply column is PAD + textWidth wide, and input starts after the prompt.
    width: () => Math.max(10, textWidth() - (width(q) - PAD.length)),
    history,
    initial: rude_.call("ui/take-draft"), // typed during the turn but not sent
    write,
    // :coffee: → ☕ as the closing colon is typed.
    typed: shortcodeEdit,
    // Tab: the transcript on an empty line; otherwise complete an emoji shortcode or a /command.
    // Candidates show in the row under the input.
    tab: (before) => {
      if (!ed?.text) return "transcript";
      const m = before.match(shortcode);
      if (m) {
        const names = emojiNames(m[2]);
        if (names.length === 1) return { del: m[2].length + 1, ins: EMOJI.get(names[0])! };
        if (!names.length) return { hint: PAD + grey(`no emoji :${m[2]}`) };
        const hint = fit(PAD + names.slice(0, 20).map((n) => `${EMOJI.get(n)} ${grey(n)}`).join("  "), cols() - 1);
        const c = common(names);
        return c.length > m[2].length ? { del: m[2].length, ins: c, hint } : { hint };
      }
      if (/^\/\S*$/.test(before) && before === ed.text) {
        const names = rude_.apropos("command/").map((c) => c.name).filter((n) => n.startsWith("command/"))
          .map((n) => "/" + n.slice("command/".length)).filter((n) => n.startsWith(before)).sort();
        if (names.length === 1) return { del: before.length, ins: names[0] + " " };
        if (!names.length) return { hint: PAD + grey(`no command starts with ${before}`) };
        const hint = fit(PAD + names.map((n) => accent(n)).join("  "), cols() - 1), c = common(names);
        return c.length > before.length ? { del: before.length, ins: c, hint } : { hint };
      }
    },
  });
  editing = ed;
  // Bracketed paste, so pasted newlines don't send; in tmux, modifyOtherKeys so Shift-Enter differs from Enter.
  write("\x1b[?2004h" + MOK_ON);
  keys((s, k) => {
    const whole = reassemble(s, k);
    if (whole === "swallow") return;
    const seq = whole ?? k?.sequence;
    if (NEWLINE_KEYS.includes(seq)) return ed.key(undefined, {}, true);
    if (!whole) ed.key(s, k);
  });
  return ed.result.then((r) => {
    editing = null;
    keys(null);
    write("\x1b[?2004l" + MOK_OFF);
    if (r === "transcript") return TAB;
    if (r === null) return null;
    askedRows = r.rows;
    return r.text;
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

  rude.def("ui/print", (lines: string[]) => print(lines),
    "Print lines into the scrollback, above the live region. Extensions should print with this, not console.log, " +
    "which would scribble over the live region. Lines are written as given (no margin); runs of blank lines collapse.");
  rude.def("ui/say", (text: string) => say(text), "Print text into the scrollback, indented to the UI's margin.");
  rude.defdefault("ui/live", (_width: number): string[] => [],
    "Extra lines for the live region during a turn, shown above the rule and status. Advise it to add your own.");

  rude.defdefault("ui/tool", (input: any, name: string): ToolView => ({
    title: `${name} ${input.path ? rel(input.path) : ""}`.trim(),
    lines: [grey(JSON.stringify(input))],
  }), "How a tool call looks, for tools without their own ui/tool/<name>. Takes (input, name) and returns " +
    "{ title, verb?, lines?, quiet?, did? }: the one-line title, a word for the status line, lines shown under the title " +
    "in the transcript, quiet to hide a successful result, and did ({ verb, what, noun }, e.g. ran / bun test / command) " +
    "for the summary line after a run of tool calls.");
  rude.def("ui/tool-view", (use: { name: string; input: any }): ToolView =>
    rude.call(has(`ui/tool/${use.name}`) ? `ui/tool/${use.name}` : "ui/tool", use.input ?? {}, use.name),
    "How one tool call looks: ui/tool/<name> if the tool has one, else ui/tool.");
  rude.def("ui/spinner", (t: number) => spinner(t),
    "The animation at the left of the status line, given the time in ms. Advise it to draw your own.");
  rude.def("ui/status", () => status(), "The status line during a turn: animation, what it's doing, elapsed time, hints.");
  rude.defdefault("ui/turn-key", (_s: string, _k: any, _newline: boolean) => {},
    "During a turn, a key no key/<name> handles: (sequence, key, isShiftEnter). ext/steer.ts types it into the steering line.");
  rude.defdefault("ui/next-input", (): string | null => null,
    "Before showing the prompt: a message to send instead, e.g. one queued during the last turn. null shows the prompt.");
  rude.defdefault("ui/take-draft", (): string => "", "Text to put in the next prompt, e.g. typed during a turn but not sent.");
  rude.def("ui/redraw", () => redraw(), "Redraw the live region (or the transcript, if it's open).");
  rude.defdefault("ui/tool/bash", (input: any): ToolView => {
    const [first, ...more] = String(input.command).trim().split("\n");
    return { title: `$ ${first}`, verb: "running", lines: more.map((l) => "  " + l), did: { verb: "ran", what: first, noun: "command" } };
  }, "How a bash call looks.");
  rude.defdefault("ui/tool/edit", (input: any): ToolView => {
    const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);
    return {
      title: `${input.old_string === "" ? "create" : "edit"} ${rel(input.path)}`,
      verb: "editing",
      lines: [...lines(input.old_string).map((l) => red(`- ${l}`)), ...lines(input.new_string).map((l) => green(`+ ${l}`))],
      quiet: true,
      did: { verb: input.old_string === "" ? "created" : "edited", what: basename(String(input.path)), noun: "file" },
    };
  }, "How an edit looks: the diff, and no result unless it failed.");

  rude.defdefault("key/ctrl-c", () => rude.call("cancel"), "During a turn: cancel it.");
  rude.defdefault("key/escape", () => rude.call("cancel"), "During a turn: cancel it.");

  rude.def("command/help", () => {
    const cmds = rude.apropos("command/").filter((c) => c.name.startsWith("command/"));
    print(cmds.flatMap((c) =>
      wrap(grey(c.doc.split("\n")[0]), textWidth(), accent("/" + c.name.slice("command/".length).padEnd(10)) + " ").map(pad)));
  }, "List the slash commands.");

  rude.defdefault("ui/thinking-verbs", (): string[] => VERBS,
    "What the status line says while the model thinks; one is picked each stretch. Advise to add your own.");
  rude.defdefault("ui/prompt-rule", rule, "The line printed above the prompt: a grey rule labelled with the model and context size.");

  rude.def("main", async (argv: string[]) => {
    if (tty) process.on("exit", () => write((S.alt ? "\x1b[?1049l" : "") + "\x1b[?25h\x1b[?2004l" + MOK_OFF));
    process.stdout.on("resize", () => { S.rule = null; if (S.turn) redraw(); editing?.render(); });
    // Interactive: start on a clean screen. Only the visible part is cleared; the shell's
    // earlier output is still in the scrollback.
    if (tty && process.stdin.isTTY && !argv.includes("-p")) write("\x1b[H\x1b[2J\n"); // one blank row on top
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

    const run = async (text: string) => {
      try {
        if (text.startsWith("/")) await command(text);
        else await rude.call("prompt", text);
      } catch (e: any) {
        print(["", PAD + red(String(e?.message ?? e))]);
      }
    };
    for (;;) {
      // Something typed during the last turn and still waiting goes next, without a prompt.
      const queued: string | null = rude.call("ui/next-input");
      if (queued?.trim()) {
        print(["", ...queued.split("\n").flatMap((l, i) => wrap(l, textWidth(), i ? "  " : accent("› "))).map(pad)]);
        await run(queued.trim());
        continue;
      }
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
        await new Promise<void>((r) => { S.closed = r; keys((_s, k) => rude.call("ui/transcript-key", k)); rude.call("ui/transcript"); });
        keys(null);
        continue;
      }
      if (tty) {
        // Take the rule and prompt back off the screen and print just the message, so the
        // turn's rule and status land exactly where the rule and prompt were.
        const n = askedRows || 1;
        begin();
        write(`\x1b[${n + 1}A\r\x1b[J`);
        S.blank = true;
        if (line.trim()) print(line.split("\n").flatMap((l, i) => wrap(l, textWidth(), i ? "  " : accent("› "))).map(pad));
        end();
      } else S.blank = false;
      const text = line.trim();
      if (text) await run(text);
    }
  }, "Entry point. Flags: -c/--continue, -r/--resume, -p <prompt> (run once and exit).");

  function open(file: string) {
    rude.call("open-session", file);
    const n = rude.call("path").length;
    say(grey(`resumed ${file} (${n} entries on this branch)`));
  }

  // "/name args" calls command/<name> with the rest of the line. Features define their own.
  async function command(line: string) {
    const [, name, rest = ""] = line.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
    print([""]);
    if (name && has(`command/${name}`)) return await rude.call(`command/${name}`, rest.trim());
    say(red(`no command ${line.split(/\s/)[0]}`));
    rude.call("command/help");
  }
};
