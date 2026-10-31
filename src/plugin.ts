import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { channelInstructions, createRelayConnection } from "./channel.js";
import {
  clientUrl,
  deviceCredential,
  requestEnrollment,
  resetDeviceCredential,
  agentCredential,
  waitForEnrollment,
  type DeviceCredential,
  type Enrollment,
} from "./device-client.js";
import { toolCatalog } from "./protocol.js";

const setupSchema = z
  .object({
    url: z.string().min(1),
    device_name: z.string().trim().min(1).max(80).optional(),
    reset_device: z.boolean().default(false),
  })
  .strict();
const settingsSchema = z
  .object({ url: z.string().transform((value) => clientUrl(value).href) })
  .strict();
type State =
  | { status: "unconfigured" }
  | { status: "connecting"; url: string }
  | {
      status: "pending_approval";
      url: string;
      device_name: string;
      approval_code: string;
      fingerprint: string;
      verification_url: string;
      expires_at: number;
    }
  | { status: "connected"; url: string; client_id: string; client_name: string }
  | { status: "error"; message: string; url?: string };
const setupTool = {
  name: "setup_agentwire",
  description:
    "Connect this device to an Agentwire relay. Returns an approval code immediately; the user approves it from the dashboard on their own computer or phone. No browser login is needed here. Existing device approval is reused. reset_device replaces the local device credential: use only when the user requests re-enrollment.",
  inputSchema: z.toJSONSchema(setupSchema, { io: "input" }) as {
    type: "object";
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
};
const statusTool = {
  name: "agentwire_status",
  description:
    "Show the relay, local agent identity, and pending approval code. Use on request or after an approval notice; do not poll while waiting for approval.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};
const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** The plugin is usable before pairing: MCP initialization never waits for network or approval. */
export function createPluginAdapter(options: {
  directory?: string;
  report: (message: string) => void;
}) {
  const directory =
    options.directory ??
    process.env.AGENTWIRE_CONFIG_DIR ??
    join(homedir(), ".config", "agentwire");
  const settingsPath = join(directory, "plugin.json");
  const server = new Server(
    { name: "agentwire", version: "0.4.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: `Agentwire is a relay between coding agents and people. Call agentwire_status once to discover your client ID and connection state. If unconfigured, ask for the user's relay base URL and call setup_agentwire.
Show the returned approval code and dashboard address to the user. They approve the client on their own computer or phone. Continue other work while waiting; never poll agentwire_status. A channel notice announces completed approval or a pairing failure.
On a device-approved notice, call agentwire_status once and continue the existing task. A device-approved notice alone is not an inbox notice.
${channelInstructions}`,
    },
  );
  let state: State = { status: "unconfigured" };
  let attempt: AbortController | undefined;
  let relay: ReturnType<typeof createRelayConnection> | undefined;
  let configuring = false,
    closed = false;
  let settingsLoaded: Promise<void> = Promise.resolve();

  function controlNotice(event: string, content: string) {
    if (closed) return;
    void server
      .notification({
        method: "notifications/claude/channel",
        params: { content, meta: { event } },
      })
      .catch(() =>
        options.report(
          "Could not deliver Agentwire setup status; call agentwire_status when resuming.",
        ),
      );
  }
  async function save(url: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = settingsPath + "." + randomUUID();
    await writeFile(temporary, JSON.stringify({ url }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, settingsPath);
  }
  function failed(url: string, active: AbortController) {
    if (active !== attempt || active.signal.aborted || closed) return;
    relay?.stop();
    relay = undefined;
    state = {
      status: "error",
      url,
      message:
        "Agentwire connection or device approval failed. Check the relay and dashboard. Re-enroll with reset_device only if the user requests it.",
    };
    options.report(state.message);
  }
  async function connect(
    credential: DeviceCredential,
    active: AbortController,
    notify: boolean,
  ) {
    const agent = await agentCredential(
      credential,
      `${server.getClientVersion()?.name ?? "Agent"} · ${hostname()}`.slice(
        0,
        80,
      ),
      active.signal,
    );
    if (active !== attempt || closed || active.signal.aborted) return;
    state = {
      status: "connected",
      url: credential.url,
      client_id: agent.client.id,
      client_name: agent.client.name,
    };
    relay = createRelayConnection(server, {
      url: credential.url,
      token: agent.token,
      report: options.report,
      fatal: () => {
        failed(credential.url, active);
        controlNotice(
          "connection-rejected",
          "Agentwire access was rejected. Call agentwire_status once; ask the user before re-enrolling this device.",
        );
      },
    });
    relay.start();
    if (notify)
      controlNotice(
        "device-approved",
        "Agentwire device approval completed. Call agentwire_status once to learn your agent ID, then continue the existing task. Future inbox notices announce peer messages.",
      );
  }
  function wait(
    credential: DeviceCredential,
    enrollment: Enrollment,
    active: AbortController,
  ) {
    void waitForEnrollment(credential, enrollment, active.signal)
      .then(() => connect(credential, active, true))
      .catch(() => {
        if (active !== attempt || active.signal.aborted || closed) return;
        failed(credential.url, active);
        controlNotice(
          "approval-failed",
          "Agentwire device approval did not complete. Call agentwire_status once. Ask the user before requesting a fresh approval; do not retry or poll automatically.",
        );
      });
  }
  async function setup(
    input: z.infer<typeof setupSchema>,
    signal?: AbortSignal,
  ) {
    const url = clientUrl(input.url);
    if (configuring)
      return result(
        {
          status: "connecting",
          message: "Device setup is already in progress. Wait for its result.",
        },
        true,
      );
    if (
      !input.reset_device &&
      "url" in state &&
      state.url === url.href &&
      ["pending_approval", "connected"].includes(state.status)
    )
      return result(state);
    configuring = true;
    attempt?.abort();
    relay?.stop();
    relay = undefined;
    const active = new AbortController();
    attempt = active;
    state = { status: "connecting", url: url.href };
    try {
      if (input.reset_device) await resetDeviceCredential(url, directory);
      const credential = await deviceCredential(
        url,
        directory,
        input.device_name ?? hostname(),
      );
      const enrollment = await requestEnrollment(
        credential,
        AbortSignal.any([active.signal, ...(signal ? [signal] : [])]),
      );
      active.signal.throwIfAborted();
      signal?.throwIfAborted();
      await save(url.href);
      if (enrollment.status === "approved")
        await connect(credential, active, false);
      else {
        state = {
          status: "pending_approval",
          url: url.href,
          device_name: credential.name,
          approval_code:
            enrollment.user_code.slice(0, 4) +
            "-" +
            enrollment.user_code.slice(4),
          fingerprint: createHash("sha256")
            .update(credential.token)
            .digest("hex")
            .slice(0, 16),
          verification_url: enrollment.verification_url,
          expires_at: enrollment.expires_at,
        };
        wait(credential, enrollment, active);
      }
      return result(state);
    } catch {
      failed(url.href, active);
      return result(state, true);
    } finally {
      configuring = false;
    }
  }
  server.oninitialized = () => {
    settingsLoaded = (async () => {
      let settings: z.infer<typeof settingsSchema>;
      try {
        settings = settingsSchema.parse(
          JSON.parse(await readFile(settingsPath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          state = {
            status: "error",
            message:
              "Agentwire settings could not be read. Run setup_agentwire with your relay URL to replace them.",
          };
        return;
      }
      if (!closed) void setup({ ...settings, reset_device: false });
    })();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [setupTool, statusTool, ...toolCatalog],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    await settingsLoaded;
    if (request.params.name === "agentwire_status") {
      z.object({})
        .strict()
        .parse(request.params.arguments ?? {});
      return result(state);
    }
    if (request.params.name === "setup_agentwire") {
      try {
        return await setup(
          setupSchema.parse(request.params.arguments ?? {}),
          context.signal,
        );
      } catch {
        return result(
          {
            error:
              "Invalid Agentwire setup. Supply an HTTPS relay base URL (loopback HTTP is permitted for local testing).",
          },
          true,
        );
      }
    }
    if (!relay || state.status !== "connected")
      return result(
        {
          error:
            "Agentwire is not connected. Call agentwire_status once for setup instructions; do not poll.",
          ...state,
        },
        true,
      );
    return relay.call(
      request.params.name,
      request.params.arguments,
      context.signal,
    );
  });
  function stop() {
    closed = true;
    attempt?.abort();
    relay?.stop();
  }
  server.onclose = stop;
  return {
    server,
    async close() {
      stop();
      await server.close();
    },
  };
}
