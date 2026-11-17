// Type while rude works. Enter queues the message; at the next tool call boundary it
// goes to the model along with the tool results, so it can change course mid-turn.
// Whatever is still queued when the turn ends (or is stopped) is sent next.
// Text typed but not sent goes back into the prompt.
//
// The steering line is the same editor as the prompt (ui/editor.ts), drawn in the
// status area: it wraps, moves by word, recalls history, and expands :emoji:.
import type { Rude } from "../core.ts";
import { grey, accent, fit } from "./ui/markdown.ts";
import { PAD, tty, textWidth } from "./ui/term.ts";
import { Editor } from "./ui/editor.ts";
import { shortcodeEdit } from "./ui/emoji.ts";

// On globalThis, so a reload mid-turn keeps what you've typed.
const st = ((globalThis as any).rudeSteer ??= { queue: [] as string[] });
st.history ??= [];

export default (rude: Rude) => {
  const editor = (initial = "") => new Editor({
    prompt: PAD + accent("› "),
    width: () => Math.max(10, textWidth() - 2),
    history: st.history,
    initial,
    typed: shortcodeEdit,
    redraw: () => rude.call("ui/redraw"),
    submit: (text) => { st.queue.push(text.trim()); },
  });
  if (st.ed && typeof st.ed.view !== "function") st.ed = null; // left over from an older version of this file

  // Every key the turn doesn't handle itself (Esc, Ctrl-C and Tab are) goes to the steering line.
  rude.advise("ui/turn-key", "steer", (next, s: string, k: any, newline: boolean) => {
    (st.ed ??= editor()).key(s, k, newline);
    next(s, k, newline);
  });

  // Bracketed paste during the turn, so a pasted newline doesn't queue half a message.
  rude.advise("prompt", "steer", async (next, ...args) => {
    if (tty) process.stdout.write("\x1b[?2004h");
    try { return await next(...args); } finally { if (tty) process.stdout.write("\x1b[?2004l"); }
  });

  rude.advise("ui/live", "steer", (next, w: number) => {
    const out: string[] = [...next(w)];
    for (const q of st.queue) out.push(PAD + grey(fit(`queued › ${q.replace(/\n/g, " ⏎ ")}`, w)));
    if (st.ed && (st.ed.text || st.ed.hint)) out.push(...st.ed.view());
    return out;
  });

  // Steering: queued messages ride along with the next tool results.
  rude.advise("append-entry", "steer", (next, e) => {
    const c = e.message?.content;
    if (!st.queue.length || e.message?.role !== "user" || !Array.isArray(c) || !c.some((b: any) => b.type === "tool_result"))
      return next(e);
    const msgs = st.queue.splice(0);
    for (const m of msgs) rude.call("ui/say", `${accent("›")} ${m}`);
    const text = `[The user sent ${msgs.length > 1 ? "these messages" : "this"} while you were working]\n${msgs.join("\n\n")}`;
    return next({ ...e, message: { ...e.message, content: [...c, { type: "text", text }] } });
  });

  // Advice, not def: it survives ui-line.ts redefining its defaults on reload.
  rude.advise("ui/next-input", "steer", (next) => {
    const msgs = st.queue.splice(0); // queued during the last turn, not yet seen by the model
    return msgs.length ? msgs.join("\n\n") : next();
  });

  rude.advise("ui/take-draft", "steer", (next) => {
    const d = st.ed?.text ?? ""; // typed during the last turn but not queued
    st.ed = null;
    return d || next();
  });
};
