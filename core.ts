#!/usr/bin/env bun
// rude: a small coding agent.
//
// The whole program is a table of named functions. Everything, including the
// agent loop, calls through the table, so any function can be replaced (def)
// or wrapped (advise) by an extension at any time. There is no other API.

import { readdirSync, existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

type Fn = (...args: any[]) => any;
type Around = (next: Fn, ...args: any[]) => any;
type Slot = { base: Fn; doc: string; meta: Record<string, any>; file: string; advice: Map<string, Around> };

// -- the table ----------------------------------------------------------------

const table = new Map<string, Slot>();

const missing = (name: string) => () => {
  throw new Error(`rude: "${name}" is not defined`);
};

function slot(name: string): Slot {
  let s = table.get(name);
  if (!s) table.set(name, (s = { base: missing(name), doc: "", meta: {}, file: "", advice: new Map() }));
  return s;
}

let loading = ""; // the extension file currently being loaded, if any

/** Define (or redefine) a function. Advice on it survives redefinition. */
export function def(name: string, fn: Fn, doc = "", meta: Record<string, any> = {}) {
  Object.assign(slot(name), { base: fn, doc, meta, file: loading || import.meta.path });
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
  return s && { name, doc: s.doc, file: s.file, advice: [...s.advice.keys()], meta: s.meta, source: s.base.toString() };
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
  loading = file;
  try {
    const mod = await import(`${file}?v=${++version}`);
    await mod.default?.(rude);
  } finally {
    loading = "";
  }
}

export const rude = { def, advise, unadvise, call, doc, apropos, load };
export type Rude = typeof rude;

// -- session ------------------------------------------------------------------
// A session is a JSONL file: a header line, then one entry per line. An entry
// is { id, parentId, type, ... }, so entries form a tree; the leaf is where the
// conversation currently is. The file is only ever appended to.

export type Entry = { id: string; parentId: string | null; type: string; [k: string]: any };

const entries = new Map<string, Entry>();
let leaf: string | null = null;
let file: string | null = null; // created on the first append
let fd: number | null = null;

const newId = () => crypto.randomUUID().slice(0, 8);

function writeLine(obj: object) {
  if (fd === null) {
    file ??= join(call("sessions-dir"), `${new Date().toISOString().replace(/[:.]/g, "-")}_${newId()}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    const fresh = !existsSync(file) || statSync(file).size === 0;
    fd = openSync(file, "a");
    if (fresh) writeSync(fd, JSON.stringify({ type: "session", version: 1, cwd: process.cwd(), timestamp: new Date().toISOString() }) + "\n");
    // A crash can leave half a line at the end; start ours on a fresh line.
    else if (!readFileSync(file, "utf8").endsWith("\n")) writeSync(fd, "\n");
  }
  writeSync(fd, JSON.stringify(obj) + "\n");
  fsyncSync(fd);
}

def("sessions-dir", () => join(homedir(), ".rude", "sessions", process.cwd().replace(/[/\\:]/g, "-")),
  "Where this directory's session files live.");

def("session-file", () => file, "The current session file, or null before anything is written.");

def("entries", () => [...entries.values()], "Every entry in the session, all branches, in file order.");

def("new-session", () => {
  if (fd !== null) closeSync(fd);
  entries.clear();
  leaf = file = fd = null;
}, "Start an empty session. Its file is created on the first append.");

def("open-session", (path: string) => {
  call("new-session");
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; } // blank or cut-off line
    if (e.type === "session") continue;
    entries.set(e.id, e);
    leaf = e.id;
  }
  file = path;
}, "Load a session file. The leaf is its last entry.");

def("sessions", () => {
  const dir = call("sessions-dir");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
    const path = join(dir, f);
    const first = readFileSync(path, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch {} })
      .find((e) => e?.message?.role === "user" && typeof e.message.content === "string");
    return { file: path, mtime: statSync(path).mtime, title: first?.message.content ?? "" };
  }).sort((a, b) => +b.mtime - +a.mtime);
}, "This directory's sessions, newest first, each with its first user message as a title.");

def("append-entry", (e: Omit<Entry, "id" | "parentId">): Entry => {
  const entry = { id: newId(), parentId: leaf, timestamp: new Date().toISOString(), ...e } as Entry;
  writeLine(entry);
  entries.set(entry.id, entry);
  leaf = entry.id;
  return entry;
}, "Write an entry under the current leaf and make it the leaf. Advise this to observe everything.");

def("branch", (id: string | null) => {
  if (id !== null && !entries.has(id)) throw new Error(`no entry ${id}`);
  leaf = id;
}, "Move the leaf to an earlier entry. The next message starts a new branch from there.");

def("close-dangling", () => {
  const e = leaf ? entries.get(leaf) : undefined;
  const content = e?.type === "message" && e.message.role === "assistant" ? e.message.content : [];
  const uses = Array.isArray(content) ? content.filter((b: any) => b.type === "tool_use") : [];
  if (!uses.length) return;
  call("append-entry", {
    type: "message", interrupted: true,
    message: { role: "user", content: uses.map((u: any) => ({
      type: "tool_result", tool_use_id: u.id, is_error: true,
      content: "Interrupted: rude stopped before this tool call finished. It may have partly run, and a command may still be running. Check before retrying.",
    })) },
  });
}, "If the leaf is a tool call with no result (a crash, or a branch to it), record it as interrupted.");

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

let turn: AbortController | null = null;

def("signal", () => turn?.signal, "The running turn's AbortSignal. Providers and tools should stop when it fires.");
def("cancel", () => turn?.abort(), "Cancel the running turn.");

const cancelled = () => new Error("cancelled");

def("prompt", async (text: string) => {
  call("close-dangling");
  call("append-entry", { type: "message", message: { role: "user", content: text } });
  const signal = (turn = new AbortController()).signal;
  try {
    for (;;) {
      const res = await call("send-request", await call("build-context"));
      if (signal.aborted) throw cancelled();
      const { content, stop_reason, usage, model } = res;
      // The assistant message (with its tool calls) is logged before any tool runs.
      call("append-entry", { type: "message", message: { role: "assistant", content }, stop_reason, usage, model });
      const uses = content.filter((b: any) => b.type === "tool_use");
      if (stop_reason !== "tool_use" || uses.length === 0) return res;
      // One at a time, in order: a reply can hold an edit followed by a test run.
      const results = [];
      for (const u of uses) {
        results.push(signal.aborted
          ? { type: "tool_result", tool_use_id: u.id, content: "Cancelled by the user before it ran.", is_error: true }
          : await call("run-tool", u));
      }
      call("append-entry", { type: "message", message: { role: "user", content: results } });
      if (signal.aborted) throw cancelled();
    }
  } catch (e: any) {
    throw signal.aborted ? cancelled() : e; // an aborted fetch throws its own error
  } finally {
    turn = null;
  }
}, "Send a user message and loop: request, run tool calls, repeat until the model stops. Throws \"cancelled\" on cancel.");

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
