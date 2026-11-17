// Spike: stream a Messages API response with plain fetch, no SDK.
// Parses SSE and rebuilds the content blocks (text, thinking, tool_use).
//
//   bun spikes/stream.ts --fixture        # offline, parses a canned stream
//   ANTHROPIC_API_KEY=... bun spikes/stream.ts "say hi"

type Block = { type: string; [k: string]: any };

// Turn a byte stream into SSE events. One event is lines up to a blank line.
export async function* sse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

// Fold events into a final message. Calls onText for each text delta.
export async function collect(events: AsyncIterable<any>, onText = (_: string) => {}) {
  const blocks: Block[] = [];
  const partialJson: string[] = [];
  let stop_reason: string | null = null;
  let usage: any = {};
  for await (const e of events) {
    switch (e.type) {
      case "message_start":
        usage = e.message.usage ?? {};
        break;
      case "content_block_start":
        blocks[e.index] = { ...e.content_block };
        partialJson[e.index] = "";
        break;
      case "content_block_delta": {
        const b = blocks[e.index], d = e.delta;
        if (d.type === "text_delta") { b.text += d.text; onText(d.text); }
        else if (d.type === "thinking_delta") b.thinking += d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta") partialJson[e.index] += d.partial_json;
        break;
      }
      case "content_block_stop": {
        const b = blocks[e.index];
        if (b.type === "tool_use") b.input = partialJson[e.index] ? JSON.parse(partialJson[e.index]) : {};
        break;
      }
      case "message_delta":
        stop_reason = e.delta.stop_reason ?? stop_reason;
        usage = { ...usage, ...e.usage };
        break;
      case "error":
        throw new Error(`${e.error.type}: ${e.error.message}`);
    }
  }
  return { content: blocks, stop_reason, usage };
}

const FIXTURE = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"bash","input":{}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"l"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"s\\"}"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

// Split the fixture into awkward chunks so events straddle chunk boundaries.
function chunked(s: string, size = 7) {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
}

if (import.meta.main) {
  if (process.argv[2] === "--fixture") {
    const msg = await collect(sse(chunked(FIXTURE)));
    console.log(JSON.stringify(msg, null, 2));
    const ok = msg.content[0].text === "Hello" && msg.content[1].input.command === "ls" && msg.stop_reason === "tool_use";
    process.exit(ok ? 0 : 1);
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      stream: true,
      fallbacks: "default",
      messages: [{ role: "user", content: process.argv[2] ?? "Say hi in five words." }],
    }),
  });
  if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }
  const msg = await collect(sse(res.body!), (t) => process.stdout.write(t));
  console.log("\n\n" + JSON.stringify({ stop_reason: msg.stop_reason, usage: msg.usage, blocks: msg.content.map((b) => b.type) }));
}
