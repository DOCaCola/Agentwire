import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(
    new URL("../plugins/agentwire/.codex-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
);
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
if (manifest.version !== pkg.version)
  throw new Error("Plugin and package versions must match");
const result = await build({
  entryPoints: ["src/plugin-entry.ts"],
  outfile: "plugins/agentwire/mcp/agentwire.cjs",
  bundle: true,
  platform: "node",
  target: "node24.13",
  format: "cjs",
  minify: true,
  legalComments: "eof",
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path))
      throw new Error("Plugin has an unbundled dependency: " + dependency.path);
  }
}
const packages = [
  ...new Set(
    Object.keys(result.metafile.inputs)
      .map((path) => path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1])
      .filter(Boolean),
  ),
].sort();
const notices = [];
for (const directory of packages) {
  const metadata = JSON.parse(
    await readFile(directory + "/package.json", "utf8"),
  );
  const licenses = (await readdir(directory))
    .filter((name) => /^(licen[sc]e|notice|copying)(\.|$)/i.test(name))
    .sort();
  if (!licenses.length)
    throw new Error(
      "Missing license text for bundled dependency: " + metadata.name,
    );
  notices.push(
    `${metadata.name}@${metadata.version}\n${licenses.map((name) => name + "\n" + "-".repeat(60)).join("\n")}\n${(await Promise.all(licenses.map((name) => readFile(directory + "/" + name, "utf8")))).join("\n")}`,
  );
}
await writeFile(
  "plugins/agentwire/mcp/THIRD_PARTY_NOTICES.txt",
  "Bundled JavaScript dependency licenses\n\n" +
    notices.join("\n\n" + "=".repeat(72) + "\n\n"),
);
