// Before each model request, reload any extension file that is new or changed.
// No file watcher: checking modification times is simpler and also notices
// new files and folders (like a ./.rude/ the agent just created).
import type { Rude } from "../core.ts";
import { statSync } from "node:fs";

const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

export default (rude: Rude) => {
  // Everything that exists now was just loaded at startup.
  const seen = new Map<string, number>(rude.call("extension-files").map((f: string) => [f, mtime(f)]));

  rude.def("reload-changed", async () => {
    const errors: string[] = [];
    for (const f of rude.call("extension-files")) {
      const m = mtime(f);
      if (seen.get(f) === m) continue;
      seen.set(f, m);
      try { await rude.load(f); }
      catch (e: any) { errors.push(`${f}: ${e?.message ?? e}`); }
    }
    return errors;
  }, "Reload extension files that changed since they were last loaded. Returns load errors.");

  rude.advise("build-context", "reload", async (next) => {
    const errors = await rude.call("reload-changed");
    const ctx = await next();
    // Tell the model, so it can fix an extension it just wrote.
    if (errors.length) {
      const last = ctx.messages.at(-1);
      const note = { type: "text", text: `[rude] extension failed to load:\n${errors.join("\n")}` };
      last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }, note] : [...last.content, note];
    }
    return ctx;
  });
};
