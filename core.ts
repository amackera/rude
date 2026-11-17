#!/usr/bin/env bun
// rude: a small coding agent.
//
// The whole program is a table of named functions. Everything, including the
// agent loop, calls through the table, so any function can be replaced (def)
// or wrapped (advise) by an extension at any time. There is no other API.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Fn = (...args: any[]) => any;
type Around = (next: Fn, ...args: any[]) => any;
type Slot = { base: Fn; doc: string; meta: Record<string, any>; advice: Map<string, Around> };

// -- the table ----------------------------------------------------------------

const table = new Map<string, Slot>();

const missing = (name: string) => () => {
  throw new Error(`rude: "${name}" is not defined`);
};

function slot(name: string): Slot {
  let s = table.get(name);
  if (!s) table.set(name, (s = { base: missing(name), doc: "", meta: {}, advice: new Map() }));
  return s;
}

/** Define (or redefine) a function. Advice on it survives redefinition. */
export function def(name: string, fn: Fn, doc = "", meta: Record<string, any> = {}) {
  Object.assign(slot(name), { base: fn, doc, meta });
}

/** Wrap a function. `id` names the advice so reloading replaces it instead of stacking. */
export function advise(name: string, id: string, around: Around) {
  slot(name).advice.set(id, around);
}

export function unadvise(name: string, id: string) {
  table.get(name)?.advice.delete(id);
}

/** Call a function by name, through its advice. Later advice runs outermost. */
export function call(name: string, ...args: any[]): any {
  const s = table.get(name);
  if (!s) throw new Error(`rude: "${name}" is not defined`);
  let fn = s.base;
  for (const around of s.advice.values()) {
    const inner = fn;
    fn = (...xs) => around(inner, ...xs);
  }
  return fn(...args);
}

export function doc(name: string) {
  const s = table.get(name);
  return s && { name, doc: s.doc, meta: s.meta, advice: [...s.advice.keys()] };
}

/** Names (and docs) matching a substring. */
export function apropos(query = "") {
  const q = query.toLowerCase();
  return [...table.entries()]
    .filter(([n, s]) => n.toLowerCase().includes(q) || s.doc.toLowerCase().includes(q))
    .map(([name, s]) => ({ name, doc: s.doc }));
}

let version = 0;

/** Load an extension file: its default export is called with the rude API. */
export async function load(file: string) {
  const mod = await import(`${file}?v=${++version}`);
  await mod.default?.(rude);
}

export const rude = { def, advise, unadvise, call, doc, apropos, load };
export type Rude = typeof rude;

// -- session ------------------------------------------------------------------
// An entry is { id, parentId, type, ... }. Entries form a tree; the leaf is
// where the conversation currently is. Held in memory for now.

export type Entry = { id: string; parentId: string | null; type: string; [k: string]: any };

const entries = new Map<string, Entry>();
let leaf: string | null = null;

def("append-entry", (e: Omit<Entry, "id" | "parentId">): Entry => {
  const entry = { id: crypto.randomUUID().slice(0, 8), parentId: leaf, ...e } as Entry;
  entries.set(entry.id, entry);
  leaf = entry.id;
  return entry;
}, "Add an entry under the current leaf and make it the leaf. Advise this to observe everything.");

def("path", (id: string | null = leaf): Entry[] => {
  const out: Entry[] = [];
  for (let e = id ? entries.get(id) : undefined; e; e = e.parentId ? entries.get(e.parentId) : undefined) out.push(e);
  return out.reverse();
}, "Entries from the root to `id` (default: the current leaf).");

def("tools", () =>
  [...table.entries()]
    .filter(([name]) => name.startsWith("tool/"))
    .map(([name, s]) => ({ name: name.slice(5), description: s.doc, input_schema: s.meta.schema })),
"Tool definitions sent to the model: every function named tool/<name>, with meta.schema.");

def("build-context", () => ({
  system: call("system-prompt"),
  tools: call("tools"),
  messages: call("path").filter((e: Entry) => e.type === "message").map((e: Entry) => e.message),
}), "Everything the next model request contains, built from the current path.");

// -- the loop -----------------------------------------------------------------

def("stream-delta", (_d: { type: "text" | "thinking"; text: string }) => {},
  "Called by providers for each streamed chunk. A UI redefines or advises this.");

def("run-tool", async (use: { id: string; name: string; input: any }) => {
  try {
    const out = await call(`tool/${use.name}`, use.input);
    return { type: "tool_result", tool_use_id: use.id, content: String(out) };
  } catch (e: any) {
    return { type: "tool_result", tool_use_id: use.id, content: String(e?.message ?? e), is_error: true };
  }
}, "Run one tool call and turn its result or error into a tool_result block.");

def("prompt", async (text: string) => {
  call("append-entry", { type: "message", message: { role: "user", content: text } });
  for (;;) {
    const res = await call("send-request", call("build-context"));
    const { content, stop_reason, usage, model } = res;
    // The assistant message (with its tool calls) is logged before any tool runs.
    call("append-entry", { type: "message", message: { role: "assistant", content }, stop_reason, usage, model });
    const uses = content.filter((b: any) => b.type === "tool_use");
    if (stop_reason !== "tool_use" || uses.length === 0) return res;
    // One at a time, in order: a reply can hold an edit followed by a test run.
    const results = [];
    for (const u of uses) results.push(await call("run-tool", u));
    call("append-entry", { type: "message", message: { role: "user", content: results } });
  }
}, "Send a user message and loop: request, run tool calls, repeat until the model stops.");

// -- boot ---------------------------------------------------------------------

const tsFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => join(dir, f)) : [];

def("extension-files", () => [
  ...tsFiles(join(import.meta.dir, "ext")),
  ...[join(homedir(), ".rude", "init.ts")].filter(existsSync),
  ...tsFiles(join(process.cwd(), ".rude")),
], "Extensions to load, in order: built-in ext/, ~/.rude/init.ts, then ./.rude/*.ts. Later defs win.");

if (import.meta.main) {
  for (const f of call("extension-files")) await load(f);
  await call("main", process.argv.slice(2));
}
