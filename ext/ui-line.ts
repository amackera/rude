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
  if (e.type === "compaction") out(dim(`\n[compacted ~${Math.round(e.tokensBefore / 1000)}k tokens into a summary]\n`));
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
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => rl.question(q);
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
      list.forEach((s: any, i: number) =>
        out(`${String(i + 1).padStart(2)}. ${dim(s.mtime.toLocaleString())}  ${s.title.split("\n")[0].slice(0, 70)}\n`));
      const pick = list[Number(await ask("session: ")) - 1];
      if (pick) open(pick.file);
    }

    const p = args.indexOf("-p");
    if (p !== -1) {
      rl.close();
      await rude.call("prompt", args.slice(p + 1).join(" "));
      out("\n");
      process.exit(0);
    }

    // Ctrl-C cancels the running turn; at the prompt it quits.
    let busy = false;
    rl.on("SIGINT", () => (busy ? rude.call("cancel") : rl.close()));
    rl.on("close", () => process.exit(0));
    for (;;) {
      const line = (await ask("\n\x1b[1m›\x1b[0m ")).trim();
      if (!line) continue;
      busy = true;
      try {
        if (line.startsWith("/")) await command(line);
        else await rude.call("prompt", line);
      } catch (e: any) {
        out(`\n\x1b[31m${e?.message ?? e}\x1b[0m\n`);
      } finally {
        busy = false;
      }
    }
  }, "Entry point. Flags: -c/--continue, -r/--resume, -p <prompt> (run once and exit).");

  function open(file: string) {
    rude.call("open-session", file);
    const n = rude.call("path").length;
    out(dim(`resumed ${file} (${n} entries on this branch)\n`));
  }

  async function command(line: string) {
    const [cmd, arg] = line.split(/\s+/);
    if (cmd === "/new") { rude.call("new-session"); out(dim("new session\n")); }
    else if (cmd === "/tree") tree();
    else if (cmd === "/branch") {
      const restored = await rude.call("branch", arg ?? null);
      out(dim(`now at ${arg ?? "the root"}\n`));
      if (Array.isArray(restored) && restored.length) out(dim(`restored files: ${restored.join(", ")}\n`));
    }
    else if (cmd === "/compact") await rude.call("compact", line.slice(cmd.length).trim());
    else if (cmd === "/session") out(`${rude.call("session-file") ?? "(nothing written yet)"}\n`);
    else out("commands: /new  /tree  /branch <id>  /compact [instructions]  /session\n");
  }

  // Print the session tree. Indent only where it branches, so long linear runs stay flat.
  function tree() {
    const all: Entry[] = rude.call("entries");
    const kids = new Map<string | null, Entry[]>();
    for (const e of all) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
    const onPath = new Set(rude.call("path").map((e: Entry) => e.id));
    const walk = (parent: string | null, depth: number) => {
      const children = kids.get(parent) ?? [];
      for (const e of children) {
        const text = label(e);
        if (text) out(`${"  ".repeat(depth)}${onPath.has(e.id) ? "*" : " "} ${dim(e.id)} ${text}\n`);
        walk(e.id, children.length > 1 ? depth + 1 : depth);
      }
    };
    walk(null, 0);
  }

  function label(e: Entry) {
    if (e.type !== "message") return `[${e.type}]`;
    const { role, content } = e.message;
    if (typeof content === "string") return `you: ${content.split("\n")[0].slice(0, 70)}`;
    const text = content.find((b: any) => b.type === "text")?.text;
    const tools = content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
    if (role === "assistant") return text ? `rude: ${text.split("\n")[0].slice(0, 70)}` : tools.length ? dim(`→ ${tools.join(", ")}`) : "";
    return ""; // tool results
  }
};
