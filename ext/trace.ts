// Write every model request and response to ~/.rude/trace/<run>/NNN.json,
// so you can read exactly what the model saw and said.
import type { Rude } from "../core.ts";
import { join } from "node:path";
import { homedir } from "node:os";

const run = new Date().toISOString().replace(/[:.]/g, "-");
let n = 0;

export default (rude: Rude) => {
  rude.def("trace-dir", () => join(homedir(), ".rude", "trace", run), "Where this run's trace files go.");

  rude.advise("send-request", "trace", async (next, ctx) => {
    const file = join(rude.call("trace-dir"), `${String(++n).padStart(3, "0")}.json`);
    // The exact HTTP body if the provider exposes one, otherwise the context.
    const request = rude.doc("anthropic/body") ? rude.call("anthropic/body", ctx) : ctx;
    try {
      const response = await next(ctx);
      await Bun.write(file, JSON.stringify({ request, response }, null, 2));
      return response;
    } catch (error: any) {
      await Bun.write(file, JSON.stringify({ request, error: String(error?.message ?? error) }, null, 2));
      throw error;
    }
  });
};
