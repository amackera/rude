// Compaction: when the context gets big, replace older messages with a summary.
// The originals stay in the session file; a `compaction` entry just changes
// what later requests contain.
import type { Rude, Entry } from "../core.ts";

const inputTokens = (u: any) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
const estimate = (x: unknown) => JSON.stringify(x).length / 4; // rough tokens
const messagesOf = (es: Entry[]) => es.filter((e) => e.type === "message").map((e) => e.message);
const lastCompaction = (path: Entry[]) => path.findLastIndex((e) => e.type === "compaction");

// Add text to the end of a message list without changing the stored entries.
export function addText(messages: any[], text: string) {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return [...messages, { role: "user", content: text }];
  const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  return [...messages.slice(0, -1), { ...last, content: [...content, { type: "text", text }] }];
}

export default (rude: Rude) => {
  rude.def("compact/threshold", () => 150_000, "Compact before a request once the previous one's input passed this many tokens. About 75% of a 200k window.");
  rude.def("compact/keep", () => 20_000, "About how many tokens of the most recent conversation to keep word for word.");
  rude.def("compact/prompt", () =>
    "Summarize the conversation so far so that you could continue the work from the summary alone. " +
    "Cover what the user asked for, decisions made, what was done (files changed, commands run and what they showed), " +
    "what is in progress, and what comes next. Keep exact file paths, names and error messages. Do not call tools.",
  "The instruction sent to produce a summary.");

  rude.def("compacted-messages", (path: Entry[]) => {
    const i = lastCompaction(path);
    if (i === -1) return messagesOf(path);
    const c = path[i];
    const k = path.findIndex((e) => e.id === c.firstKeptId);
    const kept = k === -1 ? [] : path.slice(k, i);
    return [{ role: "user", content: `[Summary of the earlier conversation]\n\n${c.summary}` },
      ...messagesOf(kept), ...messagesOf(path.slice(i + 1))];
  }, "The messages a request should contain, given the latest compaction on the path.");

  rude.def("compact", async (instructions = "") => {
    const path: Entry[] = rude.call("path");
    const messages = rude.call("compacted-messages", path);
    const ask = rude.call("compact/prompt") + (instructions ? `\n\n${instructions}` : "");
    const res = await rude.call("send-request", {
      system: rude.call("system-prompt"), tools: rude.call("tools"),
      messages: addText(messages, ask), tool_choice: { type: "none" },
    });
    const summary = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    // Keep the longest recent stretch that fits the budget. It has to start at a
    // plain user message: one holding tool results would lose its tool calls.
    // Keep at most half of what is being compacted, so compacting always shrinks the context.
    const since = path.slice(lastCompaction(path) + 1);
    const budget = Math.min(rude.call("compact/keep"), estimate(messages) / 2);
    let firstKeptId: string | null = null;
    for (let i = since.length - 1, size = 0; i >= 0; i--) {
      size += estimate(since[i].message ?? since[i]);
      if (size > budget) break;
      if (since[i].type === "message" && since[i].message.role === "user" && typeof since[i].message.content === "string") firstKeptId = since[i].id;
    }
    return rude.call("append-entry", { type: "compaction", summary, firstKeptId, tokensBefore: estimate(messages), usage: res.usage });
  }, "Summarize the conversation so far and continue from the summary. Optional extra instructions for the summary.");

  rude.def("command/compact", (instructions: string) => rude.call("compact", instructions),
    "[instructions]  Summarize the conversation so far, to free up context.");

  rude.advise("build-context", "compact", async (next) => {
    const path: Entry[] = rude.call("path");
    const since = path.slice(lastCompaction(path) + 1);
    const last = since.findLast((e) => e.message?.role === "assistant" && e.usage);
    if (last && inputTokens(last.usage) > rude.call("compact/threshold")) await rude.call("compact");
    const ctx = await next();
    return { ...ctx, messages: rude.call("compacted-messages", rude.call("path")) };
  });
};
