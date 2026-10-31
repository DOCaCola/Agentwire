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
      const connected = toolData(
        await a.client.callTool({ name: "agentwire_status", arguments: {} }),
      );
      assert.equal(connected.status, "connected");
      assert.match(connected.client_id, /^agent-/);
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
          to: connected.client_id,
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
      await until(() => {
        const agents = f.store
          .clients()
          .filter((client) => client.kind === "agent");
        return (
          agents.length === 2 &&
          agents.every((client) => f.hub.online(client.id) > 0)
        );
      });
      const restored = toolData(
        await b.client.callTool({ name: "agentwire_status", arguments: {} }),
      );
      assert.equal(restored.status, "connected");
      assert.notEqual(restored.client_id, connected.client_id);
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
      assert.equal((await a.client.listTools()).tools.length, 6);
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
    assert.equal(second.store.clients().length, 2);
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
