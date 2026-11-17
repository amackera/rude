// Spike: does re-importing a changed .ts file pick up the new code in Bun?
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "rude-reload-"));
const file = join(dir, "ext.ts");
const load = async (v: number) => (await import(`${file}?v=${v}`)).default;

writeFileSync(file, `export default () => "one" as string;`);
const a = await load(1);
writeFileSync(file, `export default () => "two" as string;`);
const b = await load(2);
const c = await load(2); // same query: should be cached

console.log({ first: a(), afterEdit: b(), sameQuery: c() });
if (a() !== "one" || b() !== "two") process.exit(1);
