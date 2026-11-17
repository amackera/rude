# rude

A rudimentary coding agent, for playing with and learning from.

The program is a table of named functions. Everything, including the agent loop, calls through it, so any function can be replaced with `def` or wrapped with `advise`. That is the only extension mechanism, and `~/.rude/init.ts` is the only config.

```bash
export ANTHROPIC_API_KEY=...
./core.ts                  # interactive
./core.ts -p "fix the failing test"
bun test
```

Two tools: `bash` and `edit`. Every request and response is written to `~/.rude/trace/`.

Extensions load in order from `ext/`, `~/.rude/init.ts` and `./.rude/*.ts`. Each one default-exports a function that receives `{ def, advise, unadvise, call, doc, apropos, load }`. For example, to switch model:

```ts
export default (rude) => {
  rude.def("anthropic/options", () => ({ model: "claude-sonnet-5-5", max_tokens: 64000, effort: "medium" }));
};
```
