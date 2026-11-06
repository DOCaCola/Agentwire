import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelAdapter } from "./channel.js";
import {
  agentCredential,
  clientUrl,
  deviceCredential,
  enrollDevice,
} from "./device-client.js";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

let adapter: ReturnType<typeof createChannelAdapter> | undefined;
const shutdown = new AbortController();
async function close() {
  shutdown.abort();
  await adapter?.close();
  process.stdin.destroy();
  process.stdout.end();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close();
  });
try {
  let token = process.env.AGENTWIRE_TOKEN;
  if (!token) {
    const credential = await deviceCredential(
      clientUrl(process.env.AGENTWIRE_URL ?? ""),
    );
    await enrollDevice(
      credential,
      (message) => console.error(message),
      shutdown.signal,
    );
    // AGENTWIRE_SESSION names a stable identity that survives restarts; without it the
    // identity lives as long as this process.
    const configured = process.env.AGENTWIRE_SESSION;
    const session = await agentCredential(
      credential,
      `${process.env.AGENTWIRE_AGENT_NAME ?? "Agent"} · ${hostname()}`.slice(
        0,
        80,
      ),
      shutdown.signal,
      configured ?? "process:" + randomUUID(),
      true,
    );
    token = session.token;
    console.error(
      `Agentwire connected as ${session.client!.id} (${session.client!.name}) with a ${configured ? "stable" : "process-scoped"} identity.`,
    );
  }
  adapter = createChannelAdapter({
    url: process.env.AGENTWIRE_URL ?? "",
    token,
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
  await adapter.server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 64 * 1024,
    }),
  );
} catch {
  // Neither credentials nor the URL are logged; stdio stdout is protocol-only.
  console.error(
    "Agentwire adapter failed to start. Run agentwire setup to enroll this device, or supply an explicit AGENTWIRE_TOKEN. Check the relay URL and device authorization.",
  );
  process.exitCode = 1;
  await close();
}
