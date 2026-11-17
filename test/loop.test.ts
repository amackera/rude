// The loop, tools and advice, driven by a scripted model. No network.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rude } from "../core.ts";

const ext = (f: string) => join(import.meta.dir, "..", "ext", f);
await rude.load(ext("bash.ts"));
await rude.load(ext("edit.ts"));
await rude.load(ext("system.ts"));

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
