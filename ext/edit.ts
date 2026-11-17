import type { Rude } from "../core.ts";

export default (rude: Rude) => {
  rude.def("tool/edit", async ({ path, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
    const file = Bun.file(path);
    if (old_string === "") {
      if (await file.exists()) throw new Error(`${path} already exists; pass old_string to edit it`);
      await Bun.write(path, new_string);
      return `created ${path}`;
    }
    if (!(await file.exists())) throw new Error(`${path} does not exist`);
    const text = await file.text();
    const count = text.split(old_string).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${path}; read the file again, it may have changed`);
    if (count > 1) throw new Error(`old_string appears ${count} times in ${path}; include more surrounding text so it is unique`);
    await Bun.write(path, text.replace(old_string, () => new_string));
    return `edited ${path}`;
  },
  "Replace one exact occurrence of old_string with new_string in a file. Fails if old_string is missing or not unique. " +
  "With an empty old_string, creates a new file containing new_string.",
  {
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace, including whitespace. Empty to create a new file." },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  });
};
