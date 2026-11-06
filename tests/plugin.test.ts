import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { fixture, ownerToken, toolData, until } from "./support.js";

const bundle = fileURLToPath(
  new URL("../plugins/agentwire/mcp/agentwire.cjs", import.meta.url),
);
async function plugin(directory: string, executable = bundle) {
  const client = new Client({
    name: "plugin-integration-check",
    version: "1.0.0",
  });
  const notices: { content: string; meta: Record<string, string> }[] = [];
  client.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()),
      }),
    }),
    (notice) => notices.push(notice.params),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [executable],
    cwd: tmpdir(),
    env: { AGENTWIRE_CONFIG_DIR: directory },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr!.on("data", (chunk) => (diagnostics += chunk));
  await client.connect(transport);
  return {
    client,
    notices,
    get diagnostics() {
      return diagnostics;
    },
  };
}

test(
  "standalone plugin initializes before pairing, returns a code without waiting, reuses approval, and isolates agent inboxes",
  { timeout: 15000 },
  async () => {
    const f = await fixture(undefined, "/relay");
    const directory = await mkdtemp(join(tmpdir(), "agentwire-plugin-"));
    // Only this file is copied: there are no node_modules or runtime files in the installed plugin.
    const installed = join(directory, "standalone.cjs");
    await copyFile(bundle, installed);
    const settings = join(directory, "settings");
    let a: Awaited<ReturnType<typeof plugin>> | undefined,
      b: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      a = await plugin(settings, installed);
      assert.deepEqual(a.client.getServerCapabilities(), {
        experimental: { "claude/channel": {} },
        tools: {},
      });
      assert.deepEqual(
        (await a.client.listTools()).tools.map((tool) => tool.name),
        [
          "setup_agentwire",
          "agentwire_status",
          "join_room",
          "leave_room",
          "send_message",
          "read_inbox",
          "acknowledge_messages",
          "list_clients",
        ],
      );
      assert.deepEqual(
        toolData(
          await a.client.callTool({ name: "agentwire_status", arguments: {} }),
        ),
        { status: "unconfigured" },
      );
      assert.equal(f.requests.length, 0);
      assert.equal(
        (await a.client.callTool({ name: "read_inbox", arguments: {} }))
          .isError,
        true,
      );
      const pending = toolData(
        await a.client.callTool({
          name: "setup_agentwire",
          arguments: { url: f.url, device_name: "Plugin laptop" },
        }),
      );
      assert.equal(pending.status, "pending_approval");
      assert.equal(pending.verification_url, f.url + "/ui/#devices");
      assert.match(pending.approval_code, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
      assert.equal(
        f.store.clients().length,
        1,
        "no agent is provisioned before dashboard approval",
      );
      assert.equal(
        (
          await a.client.callTool({
            name: "setup_agentwire",
            arguments: { url: "http://192.0.2.10" },
          })
        ).isError,
        true,
      );
      assert.deepEqual(
        toolData(
          await a.client.callTool({
            name: "setup_agentwire",
            arguments: { url: f.url },
          }),
        ),
        pending,
      );
      await until(() =>
        f.requests.some(
          (request) => request.path === "/relay/api/enrollment/events",
        ),
      );
      assert.equal(
        f.requests.filter(
          (request) => request.path === "/relay/api/enrollment/events",
        ).length,
        1,
      );
      const device = f.identities.devices(f.store.client("owner")!)[0]!;
      assert.equal(
        (
          await f.request(`/api/devices/${device.id}`, ownerToken, {
            action: "approve",
            code: pending.approval_code.replace("-", ""),
          })
        ).status,
        200,
      );
      await until(() =>
        a!.notices.some((notice) => notice.meta.event === "device-approved"),
      );
      assert.equal(
        f.store.clients().length,
        1,
        "approval alone never creates an agent",
      );
      assert.equal(
        toolData(
          await a.client.callTool({ name: "agentwire_status", arguments: {} }),
        ).status,
        "ready",
      );
      await a.client.callTool({
        name: "join_room",
        arguments: { room: "test-room" },
      });
      const connected = toolData(
        await a.client.callTool({ name: "agentwire_status", arguments: {} }),
      );
      assert.equal(connected.status, "joined");
      assert.match(connected.client_id, /^agent-/);
      assert.equal(connected.name, "Plugin laptop");
      assert.equal(
        connected.identity_scope,
        "process",
        "a client without thread metadata gets a process-scoped identity",
      );
      const credentials = (await readdir(settings)).find((name) =>
        /^[a-f0-9]{64}\.json$/.test(name),
      )!;
      const raw = JSON.parse(
        await readFile(join(settings, credentials), "utf8"),
      );
      assert.ok(
        !JSON.stringify([
          pending,
          connected,
          a.notices,
          a.diagnostics,
        ]).includes(raw.token),
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(settings, "plugin.json"), "utf8")),
        { url: f.url + "/" },
      );
      assert.equal(
        (await stat(join(settings, "plugin.json"))).mode & 0o777,
        0o600,
      );
      const sent = await (
        await f.request("/api/messages", ownerToken, {
          to: "Plugin laptop",
          body: "Plugin directed message",
        })
      ).json();
      await until(() =>
        a!.notices.some((notice) => notice.meta.pending === "1"),
      );
      assert.equal(
        f.requests.filter((request) =>
          request.path.startsWith("/relay/api/inbox"),
        ).length,
        0,
        "setup and notifications never poll the inbox",
      );
      assert.equal(
        toolData(await a.client.callTool({ name: "read_inbox", arguments: {} }))
          .messages[0].id,
        sent.id,
      );
      await a.client.callTool({
        name: "acknowledge_messages",
        arguments: { ids: [sent.id] },
      });
      assert.equal(f.store.pending(connected.client_id), 0);
      b = await plugin(settings, installed);
      await until(
        () =>
          f.requests.filter(
            (request) => request.path === "/relay/api/enrollment",
          ).length === 2,
      );
      // A new plugin process reuses approval but remains absent from every room.
      assert.equal(
        f.store.clients().filter((client) => client.kind === "agent").length,
        1,
      );
      assert.equal(
        toolData(
          await b.client.callTool({ name: "list_clients", arguments: {} }),
        ).error.includes("Join"),
        true,
      );
      // The device name is taken in this room, so the second agent picks its own.
      assert.match(
        toolData(
          await b.client.callTool({
            name: "join_room",
            arguments: { room: "test-room" },
          }),
        ).error,
        /"Plugin laptop" is taken/,
      );
      await b.client.callTool({
        name: "join_room",
        arguments: { room: "test-room", name: "Second" },
      });
      const restored = toolData(
        await b.client.callTool({ name: "agentwire_status", arguments: {} }),
      );
      assert.equal(restored.status, "joined");
      assert.notEqual(restored.client_id, connected.client_id);
      const changes = () =>
        a!.notices.filter(
          (notice) => notice.meta.event === "participants-changed",
        );
      await until(() => changes().length === 1);
      await b.client.callTool({ name: "leave_room", arguments: {} });
      assert.equal(
        toolData(
          await b.client.callTool({ name: "agentwire_status", arguments: {} }),
        ).status,
        "ready",
      );
      const remaining = toolData(
        await a.client.callTool({ name: "list_clients", arguments: {} }),
      );
      assert.ok(
        !remaining.some((peer: { name: string }) => peer.name === "Second"),
      );
      await b.client.callTool({
        name: "join_room",
        arguments: { room: "OtherTask" },
      });
      assert.equal(
        (
          await a.client.callTool({
            name: "send_message",
            arguments: { to: "Second", body: "outside" },
          })
        ).isError,
        true,
      );
      await b.client.callTool({
        name: "join_room",
        arguments: { room: "test-room", name: "Second" },
      });
      await until(() => changes().length === 2);
      assert.equal(
        toolData(
          await b.client.callTool({ name: "agentwire_status", arguments: {} }),
        ).client_id,
        restored.client_id,
        "leaving and rejoining reuses only this process identity",
      );

      assert.equal(f.identities.devices(f.store.client("owner")!).length, 1);
      assert.equal(
        b.notices.filter((notice) => notice.meta.event === "device-approved")
          .length,
        0,
      );
      assert.equal(
        (
          await f.request(`/api/devices/${device.id}`, ownerToken, {
            action: "revoke",
          })
        ).status,
        200,
      );
      await until(() =>
        a!.notices.some(
          (notice) => notice.meta.event === "connection-rejected",
        ),
      );
      assert.equal(
        toolData(
          await a.client.callTool({ name: "agentwire_status", arguments: {} }),
        ).status,
        "error",
      );
      assert.equal(
        (
          await a.client.callTool({
            name: "send_message",
            arguments: { to: "owner", body: "Blocked" },
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await a.client.callTool({
            name: "setup_agentwire",
            arguments: { url: f.url },
          })
        ).isError,
        true,
      );
      assert.equal(
        JSON.parse(await readFile(join(settings, credentials), "utf8")).token,
        raw.token,
        "revoked credentials are never silently replaced",
      );
      const reset = toolData(
        await a.client.callTool({
          name: "setup_agentwire",
          arguments: { url: f.url, reset_device: true },
        }),
      );
      assert.equal(reset.status, "pending_approval");
      assert.notEqual(
        JSON.parse(await readFile(join(settings, credentials), "utf8")).token,
        raw.token,
      );
      assert.equal(
        f.store.clients().filter((client) => client.kind === "agent").length,
        0,
        "reset waits for a new human approval",
      );
    } finally {
      await a?.client.close();
      await b?.client.close();
      await f.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a Codex thread keeps its identity, room and waiting messages across plugin restarts",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "agentwire-plugin-thread-"));
    const thread = { threadId: "019a0000-0000-7000-8000-000000000001" };
    let a: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      a = await plugin(directory);
      const pending = toolData(
        await a.client.callTool({
          name: "setup_agentwire",
          arguments: { url: f.url, device_name: "Thread laptop" },
        }),
      );
      const device = f.identities.devices(f.store.client("owner")!)[0]!;
      await f.request(`/api/devices/${device.id}`, ownerToken, {
        action: "approve",
        code: pending.approval_code.replace("-", ""),
      });
      await until(() =>
        a!.notices.some((notice) => notice.meta.event === "device-approved"),
      );
      // Tool calls before joining look the thread up without creating an agent.
      await a.client.callTool({
        name: "agentwire_status",
        arguments: {},
        _meta: thread,
      });
      assert.equal(
        f.store.clients().filter((client) => client.kind === "agent").length,
        0,
      );
      await a.client.callTool({
        name: "join_room",
        arguments: { room: "test-room", name: "Builder" },
        _meta: thread,
      });
      const joined = toolData(
        await a.client.callTool({
          name: "agentwire_status",
          arguments: {},
          _meta: thread,
        }),
      );
      assert.equal(joined.identity_scope, "thread");
      await until(() => f.hub.online(joined.client_id) === 1);
      await a.client.close();
      await until(() => f.store.membership(joined.client_id)?.active === false);
      assert.equal(
        (
          await f.request("/api/messages", ownerToken, {
            to: "builder",
            body: "Sent while the thread was closed",
          })
        ).status,
        201,
      );

      a = await plugin(directory);
      // The first call of the resumed thread reconnects it without a rejoin.
      const inbox = toolData(
        await a.client.callTool({
          name: "read_inbox",
          arguments: {},
          _meta: thread,
        }),
      );
      assert.deepEqual(
        inbox.messages.map((message: { from: string; body: string }) => [
          message.from,
          message.body,
        ]),
        [["Owner", "Sent while the thread was closed"]],
      );
      const resumed = toolData(
        await a.client.callTool({
          name: "agentwire_status",
          arguments: {},
          _meta: thread,
        }),
      );
      assert.deepEqual(
        [resumed.status, resumed.room, resumed.name, resumed.client_id],
        ["joined", "test-room", "Builder", joined.client_id],
      );
      await until(() => f.store.membership(joined.client_id)?.active === true);
      assert.equal(
        f.store.clients().filter((client) => client.kind === "agent").length,
        1,
      );
    } finally {
      await a?.client.close();
      await f.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("an unapproved plugin restarts with the same device code and keeps setup state outside its bundle", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "agentwire-plugin-restart-"));
  let a: Awaited<ReturnType<typeof plugin>> | undefined;
  try {
    a = await plugin(directory);
    const first = toolData(
      await a.client.callTool({
        name: "setup_agentwire",
        arguments: { url: f.url },
      }),
    );
    await a.client.close();
    a = await plugin(directory);
    await until(
      () =>
        f.requests.filter(
          (request) => request.path === "/api/enrollment/events",
        ).length === 2,
    );
    const restored = toolData(
      await a.client.callTool({ name: "agentwire_status", arguments: {} }),
    );
    assert.equal(restored.status, "pending_approval");
    assert.equal(restored.approval_code, first.approval_code);
    assert.equal(restored.fingerprint, first.fingerprint);
    const queued = toolData(
      await a.client.callTool({
        name: "join_room",
        arguments: { room: "MyTask" },
      }),
    );
    assert.equal(queued.requested_room, "MyTask");
    assert.equal(f.store.clients().length, 1);
    const device = f.identities.devices(f.store.client("owner")!)[0]!;
    await f.request(`/api/devices/${device.id}`, ownerToken, {
      action: "approve",
      code: first.approval_code.replace("-", ""),
    });
    await until(() =>
      a!.notices.some((notice) => notice.meta.event === "device-approved"),
    );
    const joined = toolData(
      await a.client.callTool({ name: "agentwire_status", arguments: {} }),
    );
    assert.equal(joined.status, "joined");
    assert.equal(joined.room, "MyTask");

    assert.equal(f.identities.devices(f.store.client("owner")!).length, 1);
  } finally {
    await a?.client.close();
    await f.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a saved relay that stalls cannot block MCP initialization, tools, or shutdown",
  { timeout: 5000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agentwire-plugin-unavailable-"),
    );
    let contacted = false;
    const server = createServer((req) => {
      contacted = true;
      req.resume();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    let a: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      await writeFile(
        join(directory, "plugin.json"),
        JSON.stringify({
          url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        }),
        { mode: 0o600 },
      );
      a = await plugin(directory);
      assert.equal((await a.client.listTools()).tools.length, 8);
      await until(() => contacted);
      assert.equal(
        toolData(
          await a.client.callTool({ name: "agentwire_status", arguments: {} }),
        ).status,
        "connecting",
      );
      await a.client.close();
      a = undefined;
    } finally {
      await a?.client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("switching relays cancels the old approval stream and ignores a late approval", async () => {
  const first = await fixture(),
    second = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "agentwire-plugin-switch-"));
  let a: Awaited<ReturnType<typeof plugin>> | undefined;
  try {
    a = await plugin(directory);
    const old = toolData(
      await a.client.callTool({
        name: "setup_agentwire",
        arguments: { url: first.url },
      }),
    );
    const current = toolData(
      await a.client.callTool({
        name: "setup_agentwire",
        arguments: { url: second.url },
      }),
    );
    const oldDevice = first.identities.devices(
      first.store.client("owner")!,
    )[0]!;
    await first.request(`/api/devices/${oldDevice.id}`, ownerToken, {
      action: "approve",
      code: old.approval_code.replace("-", ""),
    });
    const currentDevice = second.identities.devices(
      second.store.client("owner")!,
    )[0]!;
    await second.request(`/api/devices/${currentDevice.id}`, ownerToken, {
      action: "approve",
      code: current.approval_code.replace("-", ""),
    });
    await until(() =>
      a!.notices.some((notice) => notice.meta.event === "device-approved"),
    );
    const status = toolData(
      await a.client.callTool({ name: "agentwire_status", arguments: {} }),
    );
    assert.equal(status.url, second.url + "/");
    assert.equal(first.store.clients().length, 1);
    assert.equal(second.store.clients().length, 1);
    assert.equal(
      a.notices.filter((notice) => notice.meta.event === "device-approved")
        .length,
      1,
    );
  } finally {
    await a?.client.close();
    await first.stop();
    await second.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
