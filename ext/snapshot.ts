// File snapshots, so branching the conversation also brings the code back.
//
// A hidden git repo per project (in ~/.rude/snapshots/, never the project's
// own .git) records the files as a git tree before each user message, before
// each model request and at the end of each turn. A `snapshot` entry is added
// only when the files changed. /branch first snapshots where you are, then
// restores the files to the nearest snapshot on the branch you move to.
//
// Only runs inside a git repo, so .gitignore keeps node_modules and friends out.
import type { Rude, Entry } from "../core.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, rmSync } from "node:fs";

async function run(cmd: string[], cwd = process.cwd()) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { code: p.exitCode, out: out, err: err.trim() };
}

export default (rude: Rude) => {
  let root: string | null | undefined; // the project's repo root; null outside git

  rude.def("snapshot/root", async () => {
    if (root === undefined) {
      const r = await run(["git", "rev-parse", "--show-toplevel"]);
      root = r.code === 0 ? r.out.trimEnd() : null;
    }
    return root;
  }, "The git work tree whose files are snapshotted, or null when not in a git repo.");

  rude.def("snapshot/git-dir", (top: string) => join(homedir(), ".rude", "snapshots", top.replace(/[/\\:]/g, "-") + ".git"),
    "Where a project's hidden snapshot repo lives.");

  const git = async (top: string, ...args: string[]) => {
    const dir = rude.call("snapshot/git-dir", top);
    if (!existsSync(dir)) {
      await run(["git", "init", "-q", "--bare", dir]);
      await run(["git", "--git-dir", dir, "config", "gc.auto", "0"]); // trees are unreferenced; never prune them
    }
    const r = await run(["git", "--git-dir", dir, "--work-tree", top, ...args], top);
    if (r.code !== 0) throw new Error(`snapshot: git ${args[0]}: ${r.err}`);
    return args[0] === "diff-tree" ? r.out : r.out.trim();
  };

  const lastSnapshot = (path: Entry[]) => path.findLast((e) => e.type === "snapshot");

  rude.def("snapshot", async () => {
    const top = await rude.call("snapshot/root");
    if (!top) return null;
    await git(top, "add", "-A");
    const tree = await git(top, "write-tree");
    if (lastSnapshot(rude.call("path"))?.tree === tree) return null;
    return rude.call("append-entry", { type: "snapshot", tree });
  }, "Record the project's files if they changed since the last snapshot on this branch.");

  rude.def("snapshot/restore", async (tree: string) => {
    const top = await rude.call("snapshot/root");
    await git(top, "add", "-A");
    const now = await git(top, "write-tree");
    if (now === tree) return [];
    // Files that exist now but not in the snapshot get deleted; the rest are rewritten.
    const added = (await git(top, "diff-tree", "-r", "--name-only", "-z", "--diff-filter=A", tree, now)).split("\0").filter(Boolean);
    for (const f of added) rmSync(join(top, f), { force: true });
    await git(top, "read-tree", tree);
    await git(top, "checkout-index", "-a", "-f");
    return (await git(top, "diff-tree", "-r", "--name-only", "-z", tree, now)).split("\0").filter(Boolean);
  }, "Make the project's files match a snapshot tree. Returns the paths that changed.");

  rude.advise("build-context", "snapshot", async (next) => {
    await rude.call("snapshot");
    return next();
  });

  // Before the user message too, so branching to that message finds the files as they were.
  rude.advise("prompt", "snapshot", async (next, text) => {
    await rude.call("snapshot");
    try { return await next(text); }
    finally { await rude.call("snapshot"); }
  });

  rude.advise("branch", "snapshot", async (next, id) => {
    await rude.call("snapshot"); // where we were, so nothing is lost
    next(id);
    const target = lastSnapshot(rude.call("path"));
    return target ? rude.call("snapshot/restore", target.tree) : [];
  });
};
