# rude

A rudimentary coding agent.

The entire program is a table of named functions, all of which can be replaced with `def` or wrapped with `advise`. That's the extension API. Config is in `~/.rude/init.ts`.

```bash
export ANTHROPIC_API_KEY=...
ln -s "$PWD/rude" ~/.local/bin/rude   # optional
rude                        # interactive; Ctrl-C cancels a turn, Tab shows what it's doing
                            # /help lists the slash commands
rude -p "fix the failing test"
rude -c                     # continue the latest session here; -r to pick one
rude apropos session        # list functions
rude doc build-context      # doc and source of one
bun test
```

Two tools: `bash` and `edit`. Sessions are JSONL trees in `~/.rude/sessions/`, and every request and response is written to `~/.rude/trace/`. Long sessions compact themselves into a summary (the originals stay in the file). Inside a git repo, the files are snapshotted into a hidden repo in `~/.rude/snapshots/`, so `/branch` brings the code back too.

Extensions load in order from `ext/`, `~/.rude/init.ts` and `./.rude/*.ts`, and a new or changed file is reloaded before the next model request. Each one default-exports a function that receives `{ def, advise, unadvise, call, doc, apropos, load }`. A tool is a function named `tool/<name>` with a JSON Schema in `meta.schema`. The terminal UI has the same kind of hooks: `/name` calls `command/<name>`, `ui/tool/<name>` sets how a tool call looks, `ui/say` prints, `ui/live` adds lines to the status area, and `key/<name>` handles a key during a turn. To switch model:

```ts
export default (rude) => {
  rude.def("anthropic/options", () => ({
    model: "claude-sonnet-5-5",
    max_tokens: 64000,
    effort: "medium",
  }));
};
```

rude knows all this too, so you can ask it to extend itself.
