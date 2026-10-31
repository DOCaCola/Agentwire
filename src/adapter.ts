import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelAdapter } from "./channel.js";

let adapter: ReturnType<typeof createChannelAdapter> | undefined;
async function close() {
  await adapter?.close();
  process.stdin.destroy();
  process.stdout.end();
}
try {
  adapter = createChannelAdapter({
    url: process.env.AGENTWIRE_URL ?? "",
    token: process.env.AGENTWIRE_TOKEN ?? "",
    report: (message) => console.error(message),
    fatal: (message) => {
      console.error(message);
      process.exitCode = 1;
      void close();
    },
  });
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
} catch {
  // Neither credentials nor the URL are logged; stdio stdout is protocol-only.
  console.error(
    "Agentwire adapter failed to start. Set AGENTWIRE_URL to the relay base URL (HTTPS or loopback HTTP) and AGENTWIRE_TOKEN to your client token.",
  );
  process.exitCode = 1;
  await close();
}
