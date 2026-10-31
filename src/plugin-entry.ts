import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPluginAdapter } from "./plugin.js";

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 24 || major! >= 27 || (major === 24 && minor! < 13))
    throw new Error(
      "Agentwire requires an existing Node 24.13–26 installation on PATH.",
    );
  const adapter = createPluginAdapter({
    report: (message) => console.error(message),
  });
  const close = async () => {
    await adapter.close();
    process.stdin.destroy();
    process.stdout.end();
  };
  process.stdin.once("end", () => {
    void close();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void close();
    });
  await adapter.server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 64 * 1024,
    }),
  );
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Agentwire plugin failed to start",
  );
  process.exitCode = 1;
});
