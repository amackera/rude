// Slash commands for sessions and branches. "/name args" in the UI calls command/<name>
// with the rest of the line; any extension can add its own the same way.
import type { Rude, Entry } from "../core.ts";
import { grey, accent } from "./ui/markdown.ts";

export default (rude: Rude) => {
  const say = (text: string) => rude.call("ui/say", text);

  rude.def("command/new", () => {
    rude.call("new-session");
    say(grey("new session"));
  }, "Start a new session.");

  rude.def("command/session", () => say(rude.call("session-file") ?? "(nothing written yet)"),
    "Show the current session file.");

  rude.def("command/branch", async (id: string) => {
    const restored = await rude.call("branch", id || null);
    say(grey(`now at ${id || "the root"}`));
    if (Array.isArray(restored) && restored.length) say(grey(`restored files: ${restored.join(", ")}`));
  }, "<id>  Continue from an earlier entry (see /tree). No id goes back to the start.");

  // Indent only where it branches, so long linear runs stay flat.
  rude.def("command/tree", () => {
    const all: Entry[] = rude.call("entries");
    const kids = new Map<string | null, Entry[]>();
    for (const e of all) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
    const onPath = new Set(rude.call("path").map((e: Entry) => e.id));
    const out: string[] = [];
    const walk = (parent: string | null, depth: number) => {
      const children = kids.get(parent) ?? [];
      for (const e of children) {
        const text = label(e);
        if (text) out.push(`${"  ".repeat(depth)}${onPath.has(e.id) ? accent("*") : " "} ${grey(e.id)} ${text}`);
        walk(e.id, children.length > 1 ? depth + 1 : depth);
      }
    };
    walk(null, 0);
    say(out.length ? out.join("\n") : grey("(nothing yet)"));
  }, "Show the session tree. * marks the current branch.");
};

function label(e: Entry) {
  if (e.type !== "message") return grey(`[${e.type}]`);
  const { role, content } = e.message;
  if (typeof content === "string") return `you: ${content.split("\n")[0].slice(0, 70)}`;
  const text = content.find((b: any) => b.type === "text")?.text;
  const tools = content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
  if (role === "assistant") return text ? `rude: ${text.split("\n")[0].slice(0, 70)}` : tools.length ? grey(`→ ${tools.join(", ")}`) : "";
  return ""; // tool results
}
