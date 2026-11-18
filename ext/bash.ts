import type { Rude } from "../core.ts";
import { join } from "node:path";

const LIMIT = 30_000;

// Drain output continuously while retaining only a bounded head and tail.
async function output(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let head = "", tail = "", total = 0;
  const keep = (text: string) => {
    total += text.length;
    const n = Math.min(LIMIT / 2 - head.length, text.length);
    head += text.slice(0, n);
    tail = (tail + text.slice(n)).slice(-LIMIT / 2);
  };
  for await (const chunk of stream) keep(decoder.decode(chunk, { stream: true }));
  keep(decoder.decode());
  return total <= LIMIT ? head + tail
    : `${head}\n\n[... ${total - LIMIT} chars cut ...]\n\n${tail}`;
}

// Each command runs in its own process group, so killing it kills everything it
// started. Commands still running when rude exits are killed the same way.
// (A kill -9 of rude can't be caught; then they carry on.)
// This file can be reloaded, so the process-wide parts are kept on globalThis
// and set up only once.
const g = globalThis as any;
const running: Set<number> = (g.rudeBashRunning ??= new Set());
const killGroup = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch {} };
if (!g.rudeBashHooks) {
  g.rudeBashHooks = true;
  process.on("exit", () => running.forEach(killGroup));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(130));
}

// Put the repo on PATH so commands can run `rude apropos` and `rude doc`.
const env = { ...process.env, PATH: `${join(import.meta.dir, "..")}:${process.env.PATH}` };

export default (rude: Rude) => {
  rude.def("tool/bash", async ({ command, timeout = 120 }: { command: string; timeout?: number }) => {
    // `exec 2>&1` merges stderr into stdout so the model sees them interleaved.
    const p = Bun.spawn(["bash", "-c", `exec 2>&1\n${command}`], { stdin: "ignore", stdout: "pipe", detached: true, env });
    running.add(p.pid);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(p.pid); }, timeout * 1000);
    const signal: AbortSignal | undefined = rude.call("signal");
    const onCancel = () => killGroup(p.pid);
    signal?.addEventListener("abort", onCancel);
    let out: string;
    try {
      if (signal?.aborted) onCancel();
      out = await output(p.stdout);
      await p.exited;
    } catch (error) {
      killGroup(p.pid);
      await p.exited;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
      running.delete(p.pid);
    }
    const status = timedOut ? `killed after ${timeout}s timeout`
      : signal?.aborted ? "cancelled by the user"
      : p.signalCode ? `killed by ${p.signalCode}` : `exit ${p.exitCode}`;
    return `${out}\n[${status}]`;
  },
  "Run a bash command in the working directory. Returns combined stdout and stderr plus the exit status. " +
  "Long output is cut in the middle. Don't start servers or watchers in the foreground; they block until the timeout.",
  {
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Seconds before the command is killed. Default 120." },
      },
      required: ["command"],
    },
  });
};
