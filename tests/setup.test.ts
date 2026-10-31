import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { fixture, ownerToken, until, toolData } from "./support.js";

test("one setup command enrolls the device, preserves Codex/Claude configuration, and starts separate agent adapters without manual tokens", async () => {
  const f = await fixture(undefined, "/relay");
  const home = await mkdtemp(join(tmpdir(), "agentwire-setup-"));
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    AGENTWIRE_CONFIG_DIR: join(home, "credentials"),
  };
  await mkdir(join(home, ".codex"));
  const original =
    '# Keep my comment\nmodel = "example"\n[mcp_servers.existing]\ncommand = "my-server"\n[mcp_servers.agentwire]\ncommand = "old-adapter"\n[mcp_servers.agentwire.env]\nOLD_TOKEN = "old"\n[projects."/example"]\ntrust_level = "trusted"\n';
  await writeFile(join(home, ".codex/config.toml"), original);
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      theme: "dark",
      projects: { "/example": { trusted: true } },
      mcpServers: { existing: { command: "keep" } },
    }),
  );
  function setup(client: string) {
    let output = "",
      errors = "";
    const child = spawn(
      process.execPath,
      [
        cli,
        "setup",
        "--url",
        f.url + "/",
        "--client",
        client,
        "--name",
        "Test device",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    return {
      child,
      done: once(child, "exit"),
      get output() {
        return output;
      },
      get errors() {
        return errors;
      },
    };
  }
  const adapters: Client[] = [];
  try {
    const first = setup("codex");
    await until(() => /Approval code:/.test(first.errors));
    assert.match(first.errors, /On your own computer or phone/);
    assert.match(first.errors, /This client needs no browser or login/);
    const device = f.identities.devices(f.store.client("owner")!)[0]!;
    const code = /Approval code: ([A-F0-9-]+)/
      .exec(first.errors)![1]!
      .replace("-", "");
    await f.request(`/api/devices/${device.id}`, ownerToken, {
      action: "approve",
      code,
    });
    assert.deepEqual(await first.done, [0, null], first.errors);
    assert.match(first.output, /configured/);
    const updated = await readFile(join(home, ".codex/config.toml"), "utf8");
    assert.ok(updated.startsWith("# Keep my comment"));
    const parsed = parse(updated);
    assert.equal(parsed.model, "example");
    assert.equal((parsed.mcp_servers as any).existing.command, "my-server");
    assert.equal((parsed.mcp_servers as any).agentwire.channel, true);
    assert.equal((parsed.mcp_servers as any).agentwire.env, undefined);
    assert.equal((parsed.projects as any)["/example"].trust_level, "trusted");
    const second = setup("claude");
    assert.deepEqual(await second.done, [0, null], second.errors);
    assert.ok(!second.errors.includes("Approval code:"));
    assert.equal(f.identities.devices(f.store.client("owner")!).length, 1);
    const claude = JSON.parse(
      await readFile(join(home, ".claude.json"), "utf8"),
    );
    assert.equal(claude.theme, "dark");
    assert.deepEqual(claude.projects, { "/example": { trusted: true } });
    assert.deepEqual(claude.mcpServers.existing, { command: "keep" });
    assert.equal(claude.mcpServers.agentwire.args[1], "adapter");
    // A newly installed client has no configuration or mcp_servers table yet.
    await unlink(join(home, ".codex/config.toml"));
    const fresh = setup("codex");
    assert.deepEqual(await fresh.done, [0, null], fresh.errors);
    const freshConfig = parse(
      await readFile(join(home, ".codex/config.toml"), "utf8"),
    );
    assert.equal((freshConfig.mcp_servers as any).agentwire.channel, true);
    async function connect(name: string) {
      const client = new Client({ name: "setup-live-check", version: "1.0.0" });
      adapters.push(client);
      const notices: unknown[] = [];
      client.setNotificationHandler(
        z.object({
          method: z.literal("notifications/claude/channel"),
          params: z.record(z.string(), z.unknown()),
        }),
        (event) => notices.push(event.params),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, "adapter", "--url", f.url + "/", "--name", name],
        env: { AGENTWIRE_CONFIG_DIR: env.AGENTWIRE_CONFIG_DIR },
        stderr: "pipe",
      });
      let errors = "";
      transport.stderr!.on("data", (chunk) => (errors += chunk));
      await client.connect(transport);
      const match = /connected as (agent-[a-f0-9]+)/.exec(errors);
      assert.ok(match, errors);
      return { client, notices, id: match[1]! };
    }
    const a = await connect("Codex A"),
      b = await connect("Codex B");
    assert.notEqual(a.id, b.id);
    const message = await (
      await f.request("/api/messages", ownerToken, {
        to: b.id,
        body: "Only B wakes up",
      })
    ).json();
    await until(() => b.notices.length === 1);
    assert.equal(a.notices.length, 0);
    const inbox = toolData(
      await b.client.callTool({ name: "read_inbox", arguments: {} }),
    );
    assert.equal(inbox.messages[0].id, message.id);
    await b.client.callTool({
      name: "acknowledge_messages",
      arguments: { ids: [message.id] },
    });
    assert.equal(f.store.pending(b.id), 0);
    assert.equal(
      (
        await f.request(`/api/devices/${device.id}`, ownerToken, {
          action: "revoke",
        })
      ).status,
      200,
    );
    assert.equal(f.store.client(a.id), undefined);
    assert.equal(f.store.client(b.id), undefined);
    assert.ok(!first.output.includes("aw_"));
    assert.ok(!first.errors.includes("aw_"));
  } finally {
    await Promise.all(adapters.map((client) => client.close()));
    await f.stop();
    await rm(home, { recursive: true, force: true });
  }
});
