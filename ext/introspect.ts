// `rude apropos <word>` and `rude doc <name>`: look inside rude from the shell.
// The model uses these through bash, the same way you would.
import type { Rude } from "../core.ts";
import { relative } from "node:path";

export default (rude: Rude) => {
  rude.advise("main", "introspect", async (next, argv: string[]) => {
    const [cmd, arg = ""] = argv;
    if (cmd === "apropos") {
      for (const { name, doc } of rude.apropos(arg)) console.log(`${name}\n    ${doc.split("\n")[0] || "(no doc)"}`);
      return;
    }
    if (cmd === "doc") {
      const d = rude.doc(arg);
      if (!d) { console.error(`rude: no function "${arg}". Try: rude apropos ${arg}`); process.exit(1); }
      const rel = relative(process.cwd(), d.file);
      console.log(`${d.name}  (defined in ${rel.startsWith("..") ? d.file : rel})`);
      if (d.advice.length) console.log(`advised by: ${d.advice.join(", ")}`);
      console.log(`\n${d.doc || "(no doc)"}\n`);
      if (d.meta.schema) console.log(`schema: ${JSON.stringify(d.meta.schema)}\n`);
      console.log(d.source);
      return;
    }
    return next(argv);
  });
};
