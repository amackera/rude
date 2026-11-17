// Anthropic Messages API provider: plain fetch and a hand-written SSE parser.
import type { Rude } from "../core.ts";

// Turn a byte stream into parsed SSE `data:` payloads. An event ends at a blank line.
async function* sse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf("\n\n")) !== -1) {
      const data = buf.slice(0, end).split("\n")
        .filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      buf = buf.slice(end + 2);
      if (data) yield JSON.parse(data);
    }
  }
}

// Fold stream events into the final message, reporting deltas as they arrive.
async function collect(events: AsyncIterable<any>, onDelta: (d: { type: string; text: string }) => void) {
  const content: any[] = [];
  const json: string[] = [];
  let stop_reason: string | null = null, usage: any = {}, model = "";
  for await (const e of events) {
    if (e.type === "message_start") ({ usage = {}, model = "" } = e.message);
    else if (e.type === "content_block_start") { content[e.index] = { ...e.content_block }; json[e.index] = ""; }
    else if (e.type === "content_block_delta") {
      const b = content[e.index], d = e.delta;
      if (d.type === "text_delta") { b.text += d.text; onDelta({ type: "text", text: d.text }); }
      else if (d.type === "thinking_delta") { b.thinking += d.thinking; onDelta({ type: "thinking", text: d.thinking }); }
      else if (d.type === "signature_delta") b.signature = d.signature;
      else if (d.type === "input_json_delta") json[e.index] += d.partial_json;
    } else if (e.type === "content_block_stop") {
      const b = content[e.index];
      if (b.type === "tool_use") b.input = json[e.index] ? JSON.parse(json[e.index]) : {};
    } else if (e.type === "message_delta") { stop_reason = e.delta.stop_reason ?? stop_reason; usage = { ...usage, ...e.usage }; }
    else if (e.type === "error") throw new Error(`anthropic: ${e.error.type}: ${e.error.message}`);
  }
  return { content: content.filter(Boolean), stop_reason, usage, model };
}

const RETRY = new Set([408, 429, 500, 502, 503, 504, 529]);

export default (rude: Rude) => {
  rude.def("anthropic/options", () => ({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    effort: "high",
  }), "Model settings. Redefine in ~/.rude/init.ts to change model or effort.");

  rude.def("anthropic/body", (ctx: any) => {
    const o = rude.call("anthropic/options");
    return {
      model: o.model,
      max_tokens: o.max_tokens,
      stream: true,
      system: ctx.system,
      tools: ctx.tools,
      messages: ctx.messages,
      ...(ctx.tool_choice && { tool_choice: ctx.tool_choice }),
      // Opus 5.5 always thinks; "summarized" streams a readable summary instead of a silent pause.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: o.effort },
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines, the API retries on another model instead of refusing.
      fallbacks: "default",
    };
  }, "The JSON body for one Messages API request, built from a context.");

  rude.def("send-request", async (ctx: any) => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    const body = JSON.stringify(rude.call("anthropic/body", ctx));
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined, err: any;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2026-10-21",
            "anthropic-beta": "server-side-fallback-2026-07-01",
          },
          body,
          signal: rude.call("signal"),
        });
      } catch (e) {
        if (rude.call("signal")?.aborted) throw e; // cancelled, don't retry
        err = e;
      }
      if (res?.ok) return collect(sse(res.body!), (d) => rude.call("stream-delta", d));
      const retryable = err || RETRY.has(res!.status);
      if (!retryable || attempt >= 4) throw new Error(err ? String(err) : `anthropic: HTTP ${res!.status}: ${await res!.text()}`);
      const after = Number(res?.headers.get("retry-after")) || 2 ** attempt;
      await Bun.sleep(after * 1000);
    }
  }, "Stream one model request. Returns { content, stop_reason, usage, model }.");
};
