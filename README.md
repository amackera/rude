# rude

A rudimentary coding agent, for playing with and learning from.

The program is a table of named functions. Everything, including the agent loop, calls through it, so any function can be replaced with `def` or wrapped with `advise`. That is the only extension mechanism, and `~/.rude/init.ts` is the only config.

```bash
export ANTHROPIC_API_KEY=...
ln -s "$PWD/rude" ~/.local/bin/rude   # optional
rude                        # interactive: /tree /branch <id> /new /session
rude -p "fix the failing test"
rude -c                     # continue the latest session here; -r to pick one
rude apropos session        # list functions
rude doc build-context      # doc and source of one
bun test
```

Two tools: `bash` and `edit`. Sessions are JSONL trees in `~/.rude/sessions/`, and every request and response is written to `~/.rude/trace/`.

Extensions load in order from `ext/`, `~/.rude/init.ts` and `./.rude/*.ts`, and a new or changed file is reloaded before the next model request. Each one default-exports a function that receives `{ def, advise, unadvise, call, doc, apropos, load }`. A tool is a function named `tool/<name>` with a JSON Schema in `meta.schema`. To switch model:

```ts
export default (rude) => {
  rude.def("anthropic/options", () => ({ model: "claude-sonnet-5-5", max_tokens: 64000, effort: "medium" }));
};
```

rude knows all this too, so you can ask it to extend itself.
