// The loop, tools and advice, driven by a scripted model. No network.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rude } from "../core.ts";

const ext = (f: string) => join(import.meta.dir, "..", "ext", f);
await rude.load(ext("bash.ts"));
await rude.load(ext("edit.ts"));
await rude.load(ext("system.ts"));
const sessions = mkdtempSync(join(tmpdir(), "rude-sessions-"));
rude.def("sessions-dir", () => sessions);

// A fake model that plays back one reply per request and records what it was sent.
function script(replies: any[]) {
  const seen: any[] = [];
  rude.def("send-request", async (ctx: any) => {
    seen.push(structuredClone(ctx));
    return replies.shift();
  });
  return seen;
}
const tool = (id: string, name: string, input: any) => ({
  content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use",
});
const done = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

test("runs tool calls and feeds the results back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rude-test-"));
  const file = join(dir, "x.txt");
  const seen = script([
    tool("t1", "edit", { path: file, old_string: "", new_string: "hello world\n" }),
    tool("t2", "edit", { path: file, old_string: "world", new_string: "rude" }),
    tool("t3", "bash", { command: `cat ${file}` }),
    done("all done"),
  ]);
  const res = await rude.call("prompt", "make a file");
  expect(res.content[0].text).toBe("all done");
  expect(readFileSync(file, "utf8")).toBe("hello rude\n");
  const last = seen.at(-1).messages.at(-1);
  expect(last.content[0]).toMatchObject({ tool_use_id: "t3", content: "hello rude\n\n[exit 0]" });
  expect(seen[0].tools.map((t: any) => t.name).sort()).toEqual(["bash", "edit"]);
});

test("edit fails loudly and the model sees the error", async () => {
  const seen = script([
    tool("t1", "edit", { path: "/nonexistent/rude", old_string: "a", new_string: "b" }),
    done("ok"),
  ]);
  await rude.call("prompt", "edit something");
  expect(seen[1].messages.at(-1).content[0]).toMatchObject({ is_error: true });
});

test("a session survives a restart", async () => {
  rude.call("new-session");
  script([done("first reply")]);
  await rude.call("prompt", "remember me");
  const file = rude.call("session-file");
  rude.call("new-session");
  expect(rude.call("path")).toEqual([]);
  rude.call("open-session", file);
  expect(rude.call("path").map((e: any) => e.message.role)).toEqual(["user", "assistant"]);
  const seen = script([done("second reply")]);
  await rude.call("prompt", "and again");
  expect(seen[0].messages.map((m: any) => m.content[0]?.text ?? m.content))
    .toEqual(["remember me", "first reply", "and again"]);
});

test("a crash mid-tool-call is recorded as interrupted", async () => {
  // A session whose last complete entry is a tool call, followed by half a line.
  const file = join(sessions, "crashed.jsonl");
  const call = { id: "a2", parentId: "a1", type: "message",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "bash", input: { command: "sleep 100" } }] } };
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 1 }),
    JSON.stringify({ id: "a1", parentId: null, type: "message", message: { role: "user", content: "go" } }),
    JSON.stringify(call),
    `{"id":"a3","parentId":"a2","type":"mess`,
  ].join("\n"));
  rude.call("open-session", file);
  const seen = script([done("recovered")]);
  await rude.call("prompt", "what happened?");
  const msgs = seen[0].messages;
  expect(msgs[2].content[0]).toMatchObject({ tool_use_id: "t9", is_error: true });
  expect(msgs[3].content).toBe("what happened?");
  // The new lines were appended cleanly after the cut-off one.
  rude.call("open-session", file);
  expect(rude.call("path").length).toBe(5);
});

test("branching continues from an earlier entry and keeps the old branch", async () => {
  rude.call("new-session");
  script([done("one"), done("two"), done("other two")]);
  await rude.call("prompt", "q1");
  const afterOne = rude.call("path").at(-1).id;
  await rude.call("prompt", "q2");
  rude.call("branch", afterOne);
  await rude.call("prompt", "q2 again");
  const texts = (es: any[]) => es.map((e) => e.message.content[0]?.text ?? e.message.content);
  expect(texts(rude.call("path"))).toEqual(["q1", "one", "q2 again", "other two"]);
  expect(rude.call("entries").length).toBe(6);
});

test("a new or changed extension file loads before the next request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rude-ext-"));
  const extFile = join(dir, "hello.ts");
  rude.def("extension-files", () => [extFile]);
  await rude.load(ext("reload.ts"));
  const tool = (v: string) => `export default (r) => r.def("tool/hello", () => "${v}", "Say hello.", { schema: { type: "object", properties: {} } });`;
  writeFileSync(extFile, tool("one"));
  const seen = script([done("a"), done("b")]);
  await rude.call("prompt", "first");
  expect(seen[0].tools.map((t: any) => t.name)).toContain("hello");
  expect(await rude.call("tool/hello")).toBe("one");
  writeFileSync(extFile, tool("two"));
  utimesSync(extFile, new Date(), new Date(Date.now() + 5000));
  await rude.call("prompt", "second");
  expect(await rude.call("tool/hello")).toBe("two");
  writeFileSync(extFile, "this is not typescript (");
  utimesSync(extFile, new Date(), new Date(Date.now() + 10000));
  const seen2 = script([done("c")]);
  await rude.call("prompt", "third");
  expect(JSON.stringify(seen2[0].messages.at(-1))).toContain("extension failed to load");
  rude.unadvise("build-context", "reload");
});

test("compaction summarizes old messages and keeps recent ones", async () => {
  await rude.load(ext("compact.ts"));
  rude.def("compact/threshold", () => 100);
  rude.def("compact/keep", () => 10);
  rude.call("new-session");
  const seen = script([
    { ...done("a1"), usage: { input_tokens: 500 } },
    done("SUMMARY: user said q1"),
    done("a2"),
  ]);
  await rude.call("prompt", "q1");
  await rude.call("prompt", "q2");
  // Request 2 asked for the summary, without tools.
  expect(seen[1].tool_choice).toEqual({ type: "none" });
  expect(JSON.stringify(seen[1].messages.at(-1))).toContain("Summarize the conversation");
  // Request 3 has the summary, then q2 kept word for word.
  expect(seen[2].messages.map((m: any) => m.content)).toEqual([
    "[Summary of the earlier conversation]\n\nSUMMARY: user said q1", "q2",
  ]);
  // Nothing was deleted: the full history is still in the session.
  expect(rude.call("entries").filter((e: any) => e.type === "message").length).toBe(4);
  // Stored entries were not modified by the summary request.
  expect(rude.call("entries").find((e: any) => e.message?.content === "q2")).toBeTruthy();
  rude.unadvise("build-context", "compact");
});

test("branching restores the files to that point", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rude-snap-"));
  const home = process.cwd();
  process.chdir(repo);
  try {
    Bun.spawnSync(["git", "init", "-q"]);
    rude.def("snapshot/git-dir", () => join(repo, "..", `${repo.split("/").pop()}-snapshots.git`));
    await rude.load(ext("snapshot.ts"));
    rude.def("snapshot/git-dir", () => join(repo, "..", `${repo.split("/").pop()}-snapshots.git`));
    rude.call("new-session");
    writeFileSync("a.txt", "v1");
    script([
      tool("t1", "bash", { command: "echo v2 > a.txt && echo new > b.txt" }),
      done("changed"),
    ]);
    await rude.call("prompt", "change things");
    expect(readFileSync("a.txt", "utf8")).toBe("v2\n");
    const first = rude.call("path").find((e: any) => e.message?.content === "change things");
    const restored = await rude.call("branch", first.id);
    expect(restored.sort()).toEqual(["a.txt", "b.txt"]);
    expect(readFileSync("a.txt", "utf8")).toBe("v1");
    expect(existsSync("b.txt")).toBe(false);
    // And forward again: the later state was snapshotted before branching away.
    const later = rude.call("entries").findLast((e: any) => e.type === "snapshot" && e.parentId !== first.id);
    await rude.call("branch", later.id);
    expect(readFileSync("b.txt", "utf8")).toBe("new\n");
  } finally {
    process.chdir(home);
    for (const [n, id] of [["build-context", "snapshot"], ["prompt", "snapshot"], ["branch", "snapshot"]]) rude.unadvise(n, id);
  }
});

test("advice wraps, survives redefinition, and is replaced by id", async () => {
  rude.def("greet", (n: string) => `hi ${n}`);
  rude.advise("greet", "loud", (next, n) => next(n).toUpperCase());
  expect(rude.call("greet", "you")).toBe("HI YOU");
  rude.def("greet", (n: string) => `yo ${n}`);
  expect(rude.call("greet", "you")).toBe("YO YOU");
  rude.advise("greet", "loud", (next, n) => next(n) + "!");
  expect(rude.call("greet", "you")).toBe("yo you!");
  expect(rude.apropos("greet").map((x) => x.name)).toEqual(["greet"]);
});
