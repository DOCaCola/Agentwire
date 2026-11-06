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
  adoptParticipant,
  clientUrl,
  deviceCredential,
  requestEnrollment,
  resetDeviceCredential,
  agentCredential,
  waitForEnrollment,
  type DeviceCredential,
  type Enrollment,
} from "./device-client.js";
import {
  invalidArguments,
  joinSchema,
  participantName,
  roomName,
  toolCatalog,
  toolDefinitions,
} from "./protocol.js";
import type { Membership } from "./store.js";

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
const emptySchema = z.object({}).strict();
const adoptSchema = z
  .object({ room: roomName, name: participantName })
  .strict();
type Join = z.infer<typeof joinSchema>;
const joinedSchema = z.object({ room: z.string(), name: z.string() });
/**
 * Codex sends the thread ID with every tool call, so a thread keeps one identity across
 * restarts. Clients without it get an identity that lasts as long as this process.
 */
type Session = { key: string; scope: "thread" | "process" };
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
  | { status: "ready"; url: string }
  | {
      status: "joined";
      url: string;
      room: string;
      name: string;
      client_id: string;
      client_name: string;
      identity_scope: Session["scope"];
    }
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
    "Show the relay, your room membership and identity, and any pending approval code. Use on request or after an approval notice; do not poll while waiting for approval.",
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
const adoptTool = {
  name: "adopt_participant",
  description:
    "Continue as an existing participant of a room in this thread: its room name, identity and waiting messages move here. Use only when the user explicitly asks this thread to take over that participant, for example after forking or handing off a thread. The thread that held it is told and leaves the room; a participant this thread held before is retired. Only agents on devices approved by the same person can be adopted.",
  inputSchema: z.toJSONSchema(adoptSchema, { io: "input" }) as {
    type: "object";
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
};
const schemas: Record<string, z.ZodType> = {
  setup_agentwire: setupSchema,
  agentwire_status: emptySchema,
  adopt_participant: adoptSchema,
  ...Object.fromEntries(
    toolDefinitions.map((tool) => [tool.name, tool.schema]),
  ),
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
  const processSession = "process:" + randomUUID();
  const server = new Server(
    { name: "agentwire", version: "0.7.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: `Agentwire is a relay between coding agents and people. Call join_room with the user's room/task name to collaborate. An approved plugin stays ready without creating an agent identity until explicitly joining. Call agentwire_status on request to inspect setup or participation. If unconfigured, ask for the user's relay base URL and call setup_agentwire.
Show the returned approval code and dashboard address to the user. They approve the client on their own computer or phone. Continue other work while waiting; never poll agentwire_status. A channel notice announces completed approval or a pairing failure.
On a device-approved notice, call agentwire_status once and continue the existing task. A device-approved notice alone is not an inbox notice.
${channelInstructions}`,
    },
  );
  let state: State = { status: "unconfigured" };
  let attempt: AbortController | undefined;
  let relay: ReturnType<typeof createRelayConnection> | undefined;
  let approved: DeviceCredential | undefined;
  let agent:
    { client: { id: string; name: string }; session: Session } | undefined;
  let requestedJoin: { join: Join; session: Session } | undefined;
  let configuring = false,
    closed = false;
  let settingsLoaded: Promise<void> = Promise.resolve();
  // The automatic reconnect after a restart; tools that act on the relay wait for it.
  let connection: Promise<unknown> = Promise.resolve();
  // Identity and room changes run one at a time so concurrent calls share one identity.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

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
    agent = undefined;
    state = {
      status: "error",
      url,
      message:
        "Agentwire connection or device approval failed. Check the relay and dashboard. Re-enroll with reset_device only if the user requests it.",
    };
    options.report(state.message);
  }
  function sessionFor(meta: Record<string, unknown> | undefined): Session {
    return typeof meta?.threadId === "string"
      ? { key: "codex-thread:" + meta.threadId, scope: "thread" }
      : { key: processSession, scope: "process" };
  }
  const clientName = () =>
    `${server.getClientVersion()?.name ?? "Agent"} · ${hostname()}`.slice(
      0,
      80,
    );
  function membershipState(membership: { room: string; name: string }) {
    state = {
      status: "joined",
      url: approved!.url,
      room: membership.room,
      name: membership.name,
      client_id: agent!.client.id,
      client_name: agent!.client.name,
      identity_scope: agent!.session.scope,
    };
  }
  /**
   * Connects this session's identity and resumes the room it already belongs to.
   * Without create, a session that never joined a room stays without an identity.
   */
  async function identify(
    session: Session,
    create: boolean,
    signal: AbortSignal,
  ) {
    if (agent || !approved || !attempt || state.status !== "ready") return;
    const active = attempt;
    const credential = approved;
    const abort = AbortSignal.any([signal, active.signal]);
    const identity = await agentCredential(
      credential,
      clientName(),
      abort,
      session.key,
      create,
    );
    active.signal.throwIfAborted();
    if (!identity.client) return;
    await attach(
      credential,
      active,
      abort,
      { ...identity, client: identity.client },
      session,
    );
  }
  /** Opens the relay connection of an identity and resumes the room it belongs to. */
  async function attach(
    credential: DeviceCredential,
    active: AbortController,
    abort: AbortSignal,
    identity: { token: string; client: { id: string; name: string } },
    session: Session,
  ) {
    const connected = createRelayConnection(server, {
      url: credential.url,
      token: identity.token,
      report: options.report,
      fatal: () => {
        failed(credential.url, active);
        controlNotice(
          "connection-rejected",
          "Agentwire access was rejected. Call agentwire_status once; ask the user before re-enrolling this device.",
        );
      },
      adopted: () => {
        if (relay !== connected) return;
        relay = undefined;
        agent = undefined;
        state = { status: "ready", url: credential.url };
        controlNotice(
          "identity-adopted",
          "Another thread took over your Agentwire participant at the user's request. This thread is no longer in a room; join again only if the user asks.",
        );
      },
    });
    let membership: Membership | null;
    try {
      membership = await connected.resume(abort);
      active.signal.throwIfAborted();
    } catch (error) {
      // The next call retries the whole identification.
      connected.stop();
      throw error;
    }
    agent = { client: identity.client, session };
    relay = connected;
    if (membership) membershipState(membership);
  }
  async function adopt(
    target: z.infer<typeof adoptSchema>,
    session: Session,
    signal: AbortSignal,
  ) {
    if (!approved || !attempt || !["ready", "joined"].includes(state.status))
      return result(
        {
          ...state,
          error: "Set up and approve this device before adopting a participant",
        },
        true,
      );
    const active = attempt;
    const credential = approved;
    const abort = AbortSignal.any([signal, active.signal]);
    // This thread's own connection closes first; its identity is retired once the adoption succeeds.
    relay?.stop();
    relay = undefined;
    agent = undefined;
    state = { status: "ready", url: credential.url };
    const identity = await adoptParticipant(
      credential,
      clientName(),
      abort,
      session.key,
      target,
    );
    active.signal.throwIfAborted();
    await attach(credential, active, abort, identity, session);
    return result(state);
  }
  async function joinRoom(join: Join, session: Session, signal: AbortSignal) {
    if (["pending_approval", "connecting"].includes(state.status)) {
      requestedJoin = { join, session };
      return result({
        ...state,
        requested_room: join.room,
        message: "The room will be joined after device approval. Do not poll.",
      });
    }
    if (!approved || !["ready", "joined"].includes(state.status))
      return result(
        {
          ...state,
          error: "Set up and approve this device before joining a room",
        },
        true,
      );
    await identify(session, true, signal);
    const joined = await relay!.call("join_room", join, signal);
    if (joined.isError) return joined;
    membershipState(joinedSchema.parse(JSON.parse(joined.content[0]!.text)));
    return joined;
  }
  async function ready(
    credential: DeviceCredential,
    active: AbortController,
    notify: boolean,
  ) {
    if (active !== attempt || closed || active.signal.aborted) return;
    approved = credential;
    state = { status: "ready", url: credential.url };
    const requested = requestedJoin;
    requestedJoin = undefined;
    let joined = false;
    if (requested)
      joined = !(
        await exclusive(() =>
          joinRoom(requested.join, requested.session, active.signal),
        ).catch((error: Error) => result({ error: error.message }, true))
      ).isError;
    if (active !== attempt || closed || active.signal.aborted) return;
    if (notify)
      controlNotice(
        "device-approved",
        requested
          ? `Agentwire device approval completed. ${joined ? "The requested room was joined" : "Joining the requested room failed"}. Call agentwire_status once, then continue your task.`
          : "Agentwire device approval completed. The plugin is ready; it has not joined a room. Call join_room only for a task the user wants to collaborate on.",
      );
  }
  function wait(
    credential: DeviceCredential,
    enrollment: Enrollment,
    active: AbortController,
  ) {
    void waitForEnrollment(credential, enrollment, active.signal)
      .then(() => ready(credential, active, true))
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
      ["pending_approval", "ready", "joined"].includes(state.status)
    )
      return result(state);
    configuring = true;
    attempt?.abort();
    relay?.stop();
    relay = undefined;
    approved = undefined;
    agent = undefined;
    requestedJoin = undefined;
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
        await ready(credential, active, false);
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
      if (!closed) connection = setup({ ...settings, reset_device: false });
    })();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [setupTool, statusTool, ...toolCatalog, adoptTool],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    await settingsLoaded;
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const session = sessionFor(request.params._meta);
    try {
      if (name === "setup_agentwire") {
        const busy = configuring;
        const setting = setup(setupSchema.parse(args), context.signal);
        if (!busy) connection = setting;
        return await setting;
      }
      // Status reports progress immediately; everything else acts once connected.
      if (name !== "agentwire_status") await connection;
      if (name === "join_room") {
        const join = joinSchema.parse(args);
        return await exclusive(() => joinRoom(join, session, context.signal));
      }
      if (name === "adopt_participant") {
        const target = adoptSchema.parse(args);
        return await exclusive(() => adopt(target, session, context.signal));
      }
      await exclusive(() => identify(session, false, context.signal));
      if (name === "agentwire_status") {
        emptySchema.parse(args);
        return result(state);
      }
      if (name === "leave_room") {
        emptySchema.parse(args);
        return await exclusive(async () => {
          requestedJoin = undefined;
          if (relay && state.status === "joined") {
            const left = await relay.call("leave_room", {}, context.signal);
            if (left.isError) return left;
          }
          if (approved) state = { status: "ready", url: approved.url };
          return result({ ...state, room: null });
        });
      }
      if (!relay || state.status !== "joined")
        return result(
          {
            error:
              "Join a task room with join_room before messaging or discovering participants. Call agentwire_status once if setup is needed; do not poll.",
            ...state,
          },
          true,
        );
      return await relay.call(name, args, context.signal);
    } catch (error) {
      if (error instanceof z.ZodError)
        return result(invalidArguments(error, schemas[name]), true);
      return result(
        {
          ...state,
          error:
            error instanceof Error ? error.message : "Agentwire request failed",
        },
        true,
      );
    }
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
