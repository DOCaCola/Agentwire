import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createAgentwire, type Options } from "../src/app.js";
import type { Message } from "../src/store.js";

export const ownerToken = "test-owner-token-with-at-least-32-characters";
export async function fixture(
  database?: string,
  basePath = "",
  oidc?: Options["oidc"],
) {
  const directory = await mkdtemp(join(tmpdir(), "agentwire-test-"));
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}${basePath}`;
  const wire = createAgentwire({
    database: database ?? join(directory, "relay.db"),
    adminToken: ownerToken,
    publicUrl: url,
    oidc,
  });
  wire.store.joinRoom("owner", { room: "test-room" });
  const requests: { method: string; path: string }[] = [];
  const server = httpServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    wire.app(req, res);
  }).listen(port, "127.0.0.1");
  await once(server, "listening");
  const connections: Client[] = [];
  const aborts: AbortController[] = [];
  async function request(
    path: string,
    token = ownerToken,
    body?: unknown,
    method?: string,
  ) {
    return fetch(url + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function add(id: string, room: string | null = "test-room") {
    const result = await request("/api/clients", ownerToken, {
      id,
      name: id.toUpperCase(),
      kind: "agent",
    });
    assert.equal(result.status, 201);
    const token = (await result.json()).token as string;
    if (room) await request("/api/rooms/join", token, { room });
    return token;
  }
  async function mcp(token: string, room: string | null = "test-room") {
    const client = new Client({
      name: "agentwire-integration-test",
      version: "1.0.0",
    });
    const notifications: Message[] = [];
    client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/agentwire/message"),
        params: z.object({
          source: z.literal("agentwire"),
          eventId: z.string(),
          message: z.custom<Message>(),
        }),
      }),
      (notification) => {
        notifications.push(notification.params.message);
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    connections.push(client);
    if (room) await client.callTool({ name: "join_room", arguments: { room } });
    // The SDK starts its standalone GET asynchronously after initialization.
    await until(() => wire.hub.online(wire.store.authenticate(token)!.id) > 0);
    return { client, transport, notifications };
  }
  async function sse(token: string, after = 0) {
    await request("/api/rooms/join", token, { room: "test-room" });
    const abort = new AbortController();
    aborts.push(abort);
    const response = await fetch(`${url}/api/events?after=${after}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const events: { type: string; data: any }[] = [];
    const reader = response.body!.getReader();
    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1],
            data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    })().catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
    return { events, abort };
  }
  return {
    ...wire,
    requests,
    url,
    request,
    add,
    mcp,
    sse,
    directory,
    async stop() {
      aborts.forEach((abort) => abort.abort());
      await Promise.all(connections.map((client) => client.close()));
      await wire.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function until(predicate: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for pushed event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export const toolData = (result: any) => JSON.parse(result.content[0].text);
