// The transcript: the whole conversation, full screen, scrollable. It opens with
// Tab (during a turn, or at an empty prompt) and closes with Tab, q or Esc.
// It renders from the session path plus the turn still running, and talks to the
// line UI through named functions: ui/print, ui/redraw, ui/status, ui/tool-view.
import type { Rude, Entry } from "../core.ts";
import { Markdown, wrap, fit, hardWrap, bold, dim, italic, red, green, grey, accent } from "./ui/markdown.ts";
import { S, PAD, pad, rows, cols, textWidth, write, begin, end, HIDE, SHOW, toText, type Step, type ToolView } from "./ui/term.ts";

let rude_: Rude;

function openTranscript() {
  S.alt = true; S.scroll = 0;
  write("\x1b[?1049h" + HIDE);
  drawTranscript();
}

function closeTranscript() {
  S.alt = false;
  write("\x1b[?1049l" + (S.turn && S.closed === null ? "" : SHOW));
  const held = S.held.splice(0);
  if (held.length) rude_.call("ui/print", held); else rude_.call("ui/redraw");
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
  const body = ["", ...shown, ...(running ? [rude_.call("ui/status")] : [""]), PAD + help].map((l) => fit(l, cols() - 1) + "\x1b[0m\x1b[K");
  begin(); write("\x1b[H" + body.join("\n")); end();
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
  const v: ToolView = rude_.call("ui/tool-view", u);
  const out = [STEP, PAD + mark + " " + bold(v.title)];
  const ind = PAD + "  ";
  out.push(...(v.lines ?? []).map((l) => ind + l));
  if (r?.body === undefined) out.push(ind + grey("running…"));
  else if (!v.quiet || r.error) out.push(...r.body.trimEnd().split("\n").map((l) => ind + (r.error ? red(l) : grey(l))));
  return out.flatMap((l) => hardWrap(l, w + PAD.length, ind + "  ")); // wrapped, not cut: this is where you read it all
}

export default (rude: Rude) => {
  rude_ = rude;
  S.cache.clear();
  rude.def("ui/transcript", openTranscript, "Open the full-screen transcript. S.closed, if set, is called when it closes.");
  rude.def("ui/transcript-draw", drawTranscript, "Redraw the transcript (while it is open).");
  rude.def("ui/transcript-key", pagerKey, "Handle a key while the transcript is open: ↑↓ steps, j k lines, pgup pgdn, g G, Tab q Esc close.");
  rude.def("key/tab", openTranscript, "During a turn: open the transcript.");
};
