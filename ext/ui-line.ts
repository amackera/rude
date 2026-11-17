// Plain line-by-line terminal UI. It only watches: streamed text via
// stream-delta, and tool calls and results via advice on append-entry.
import type { Rude, Entry } from "../core.ts";
import { createInterface } from "node:readline/promises";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const out = (s: string) => process.stdout.write(s);

const PREVIEW = 6;
function preview(text: string) {
  const lines = text.trimEnd().split("\n");
  const shown = lines.slice(0, PREVIEW).join("\n");
  return lines.length > PREVIEW ? `${shown}\n… ${lines.length - PREVIEW} more lines` : shown;
}

function show(e: Entry) {
  if (e.type !== "message") return;
  const { role, content } = e.message;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (role === "assistant" && b.type === "tool_use") {
      const label = b.name === "bash" ? `$ ${b.input.command}` : `${b.name} ${b.input.path ?? JSON.stringify(b.input)}`;
      out(`\n\x1b[36m${label}\x1b[0m\n`);
    } else if (b.type === "tool_result") {
      out(dim(preview(String(b.content))) + "\n");
    }
  }
  if (role === "assistant" && !["tool_use", "end_turn"].includes(e.stop_reason)) out(`\n[stopped: ${e.stop_reason}]\n`);
}

export default (rude: Rude) => {
  let last = "";
  rude.def("stream-delta", ({ type, text }: { type: string; text: string }) => {
    if (type !== last) out("\n");
    last = type;
    out(type === "thinking" ? dim(text) : text);
  }, "Print streamed text, with thinking dimmed.");

  rude.advise("append-entry", "ui-line", (next, e) => {
    const entry = next(e);
    last = "";
    show(entry);
    return entry;
  });

  rude.def("main", async (argv: string[]) => {
    if (argv[0] === "-p") {
      await rude.call("prompt", argv.slice(1).join(" "));
      out("\n");
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("close", () => process.exit(0));
    for (;;) {
      const line = (await rl.question("\n\x1b[1m›\x1b[0m ")).trim();
      if (!line) continue;
      try {
        await rude.call("prompt", line);
      } catch (e: any) {
        out(`\n\x1b[31m${e?.message ?? e}\x1b[0m\n`);
      }
    }
  }, "Entry point. `rude -p <prompt>` runs one prompt and exits; otherwise an interactive loop.");
};
