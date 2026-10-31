#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import {
  clientUrl,
  deviceCredential,
  enrollDevice,
  resetDeviceCredential,
} from "./device-client.js";
import { setupClient } from "./setup.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      name: { type: "string" },
      client: { type: "string" },
      session: { type: "string" },
      "no-open": { type: "boolean" },
      "reset-device": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "Usage: agentwire setup --url https://relay.example.com/ --client codex|claude [--name DEVICE] [--no-open]\n       agentwire adapter --url https://relay.example.com/ [--name AGENT] [--session STABLE-ID]\n\nSetup generates a device credential locally, waits for dashboard approval, and registers the adapter. No token copying is required.",
    );
  } else if (command === "setup") {
    if (!values.url || !values.client)
      throw new Error("setup requires --url and --client codex|claude");
    if (!["codex", "claude"].includes(values.client))
      throw new Error("Choose --client codex or --client claude");
    const url = clientUrl(values.url);
    if (values["reset-device"]) await resetDeviceCredential(url);
    const credential = await deviceCredential(
      url,
      undefined,
      values.name ?? hostname(),
    );
    const shutdown = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => shutdown.abort());
    const open = values["no-open"]
      ? undefined
      : (link: string) => {
          const [executable, args] =
            process.platform === "darwin"
              ? ["open", [link]]
              : process.platform === "win32"
                ? ["rundll32", ["url.dll,FileProtocolHandler", link]]
                : ["xdg-open", [link]];
          const child = spawn(executable!, args as string[], {
            stdio: "ignore",
            detached: true,
          });
          child.on("error", () =>
            console.error("Open the dashboard URL above in your browser."),
          );
          child.unref();
        };
    await enrollDevice(
      credential,
      (message) => console.error(message),
      shutdown.signal,
      open,
    );
    const path = await setupClient(
      values.client,
      url,
      fileURLToPath(import.meta.url),
    );
    console.log(
      `Agentwire configured in ${path}. Restart your ${values.client === "codex" ? "DOCa Codex client" : "Claude Code session"}.`,
    );
    if (values.client === "claude")
      console.log(
        "Start with: claude --dangerously-load-development-channels server:agentwire",
      );
  } else if (command === "adapter") {
    if (!values.url) throw new Error("adapter requires --url");
    process.env.AGENTWIRE_URL = clientUrl(values.url).href;
    process.env.AGENTWIRE_AGENT_NAME = values.name ?? "Agent";
    if (values.session) process.env.AGENTWIRE_SESSION = values.session;
    await import("./adapter.js");
  } else throw new Error("Unknown command. Use agentwire --help.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Agentwire setup failed",
  );
  process.exitCode = 1;
}
