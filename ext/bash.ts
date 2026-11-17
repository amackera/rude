import type { Rude } from "../core.ts";

const LIMIT = 30_000;

// Keep the start and end of long output; the middle is usually noise.
const clip = (s: string) =>
  s.length <= LIMIT ? s : `${s.slice(0, LIMIT / 2)}\n\n[... ${s.length - LIMIT} chars cut ...]\n\n${s.slice(-LIMIT / 2)}`;

// Each command runs in its own process group, so killing it kills everything it
// started. Commands still running when rude exits are killed the same way.
// (A kill -9 of rude can't be caught; then they carry on.)
const running = new Set<number>();
const killGroup = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch {} };
process.on("exit", () => running.forEach(killGroup));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(130));

export default (rude: Rude) => {
  rude.def("tool/bash", async ({ command, timeout = 120 }: { command: string; timeout?: number }) => {
    // `exec 2>&1` merges stderr into stdout so the model sees them interleaved.
    const p = Bun.spawn(["bash", "-c", `exec 2>&1\n${command}`], { stdin: "ignore", stdout: "pipe", detached: true });
    running.add(p.pid);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(p.pid); }, timeout * 1000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    running.delete(p.pid);
    const status = timedOut ? `killed after ${timeout}s timeout` : p.signalCode ? `killed by ${p.signalCode}` : `exit ${p.exitCode}`;
    return `${clip(out)}\n[${status}]`;
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
