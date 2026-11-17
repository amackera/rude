// Type while rude works. Enter queues the message; at the next tool call boundary it
// goes to the model along with the tool results, so it can change course mid-turn.
// Whatever is still queued when the turn ends (or is stopped) is sent next.
// Text typed but not sent goes back into the prompt.
import type { Rude } from "../core.ts";
import { grey, accent, fit } from "./ui/markdown.ts";
import { PAD, tty } from "./ui/term.ts";
import { expandEnd } from "./ui/emoji.ts";

// On globalThis, so a reload mid-turn keeps what you've typed.
const st = ((globalThis as any).rudeSteer ??= { draft: "", queue: [] as string[], pasting: false });

export default (rude: Rude) => {
  const redraw = () => rude.call("ui/redraw");
  const flat = (s: string) => s.replace(/\n/g, " ⏎ "); // never a newline in the live region

  rude.def("key/char", (s: string) => {
    st.draft += s;
    if (s === ":" && !st.pasting) st.draft = expandEnd(st.draft); // :coffee: → ☕
    redraw();
  }, "During a turn: type into the steering line.");
  rude.def("key/backspace", () => { st.draft = [...st.draft].slice(0, -1).join(""); redraw(); },
    "During a turn: delete the last character of the steering line.");
  rude.def("key/return", () => {
    if (st.pasting) { st.draft += "\n"; return; } // a newline inside a paste
    if (st.draft.trim()) st.queue.push(st.draft.trim());
    st.draft = "";
    redraw();
  }, "During a turn: queue the steering line. The model sees it at the next tool call, or right after the turn.");
  rude.def("key/shift-return", () => { st.draft += "\n"; redraw(); }, "During a turn: a new line in the steering text.");
  rude.def("key/paste-start", () => { st.pasting = true; }, "During a turn: a paste begins.");
  rude.def("key/paste-end", () => { st.pasting = false; redraw(); }, "During a turn: a paste ends.");

  // Bracketed paste during the turn, so a pasted newline doesn't queue half a message.
  rude.advise("prompt", "steer", async (next, ...args) => {
    if (tty) process.stdout.write("\x1b[?2004h");
    try { return await next(...args); } finally { if (tty) process.stdout.write("\x1b[?2004l"); }
  });

  rude.advise("ui/live", "steer", (next, w: number) => {
    const out: string[] = [...next(w)];
    for (const q of st.queue) out.push(PAD + grey(fit(`queued › ${flat(q)}`, w)));
    if (st.draft) out.push(PAD + accent("› ") + fit(flat(st.draft), w - 3) + "\x1b[7m \x1b[27m");
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
    const d = st.draft; // typed during the last turn but not queued
    st.draft = "";
    return d || next();
  });
};
