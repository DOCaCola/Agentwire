import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpGet } from "node:http";
import type { Message } from "../src/store.js";
import { fixture, ownerToken, until, toolData } from "./support.js";

test("MCP pushes directed and broadcast messages without polling; sender and session identities are enforced", async () => {
  const f = await fixture();
  try {
    const alice = await f.add("alice"),
      bob = await f.add("bob"),
      carol = await f.add("carol");
    const a = await f.mcp(alice),
      b = await f.mcp(bob),
      c = await f.mcp(carol);
    const listed = await a.client.listTools();
    assert.equal(listed.tools.length, 6);
    const spoof = await a.client.callTool({
      name: "send_message",
      arguments: { sender: "owner", to: "bob", body: "spoof" },
    });
    assert.equal(spoof.isError, true);
    const sent = toolData(
      await a.client.callTool({
        name: "send_message",
        arguments: { to: "bob", body: "A private question", kind: "question" },
      }),
    );
    assert.equal(sent.sender, "alice");
    await until(() => b.notifications.length === 1);
    assert.deepEqual(b.notifications[0], sent);
    assert.equal(a.notifications.length, 0);
    assert.equal(c.notifications.length, 0);
    assert.equal(
      f.store.pending("bob"),
      1,
      "notification transport delivery must not clear durable inbox",
    );
    const wrongSession = await fetch(f.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${carol}`,
        "mcp-session-id": b.transport.sessionId!,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 88, method: "tools/list" }),
    });
    assert.equal(wrongSession.status, 404);
    const broadcast = toolData(
      await a.client.callTool({
        name: "send_message",
        arguments: { to: "all", body: "Build is green" },
      }),
    );
    await until(
      () => b.notifications.length === 2 && c.notifications.length === 1,
    );
    assert.equal(c.notifications[0]!.id, broadcast.id);
    const inbox = toolData(
      await b.client.callTool({ name: "read_inbox", arguments: {} }),
    );
    assert.deepEqual(
      inbox.messages.map((message: Message) => message.id),
      [sent.id, broadcast.id],
    );
    const ack = await b.client.callTool({
      name: "acknowledge_messages",
      arguments: { ids: [sent.id, broadcast.id] },
    });
    assert.notEqual(ack.isError, true);
    assert.equal(f.store.pending("bob"), 0);
  } finally {
    await f.stop();
  }
});

test("REST, browser SSE, and MCP share recipient isolation, strict validation, and idempotency", async () => {
  const f = await fixture();
  try {
    const alice = await f.add("alice"),
      bob = await f.add("bob"),
      carol = await f.add("carol");
    const live = await f.sse(bob),
      outsider = await f.sse(carol);
    const payload = {
      to: "bob",
      body: '<script>alert("unsafe")</script>',
      idempotency_key: "retry-1",
    };
    const response = await f.request("/api/messages", alice, payload);
    assert.equal(response.status, 201);
    const sent = await response.json();
    await until(() => live.events.some((event) => event.type === "message"));
    assert.equal(
      outsider.events.filter((event) => event.type === "message").length,
      0,
    );
    const replay = await f.request("/api/messages", alice, payload);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), sent);
    assert.equal(
      (
        await f.request("/api/messages", alice, {
          ...payload,
          body: "different",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/api/messages", alice, { ...payload, sender: "owner" }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.request("/api/messages", alice, {
          to: "missing",
          body: "hello",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request("/api/messages", carol, {
          to: "alice",
          body: "leaked reference",
          reply_to: sent.id,
        })
      ).status,
      404,
    );
    assert.equal(
      (await f.request("/api/ack", carol, { ids: [sent.id] })).status,
      404,
    );
    assert.equal(
      (await f.request("/api/ack", bob, { ids: [sent.id, 99999] })).status,
      404,
    );
    assert.equal(
      f.store.pending("bob"),
      1,
      "invalid acknowledgment batch rolls back entirely",
    );
    assert.deepEqual(f.store.transcript("carol", "test-room"), []);
    assert.deepEqual(
      await (await f.request("/api/rooms/test-room/messages")).json(),
      [],
      "owner does not bypass direct-message privacy",
    );
    assert.equal(
      (await f.request("/api/rooms/test-room/messages", carol)).status,
      403,
      "agents have no transcript access outside their inbox",
    );
    const hashes = f.store.db.prepare("SELECT token_hash FROM clients").all();
    assert.ok(hashes.every((row) => String(row.token_hash).length === 64));
    live.abort.abort();
    await until(() => f.hub.online("bob") === 0);
    const recovered = await f.sse(bob, 0);
    await until(() =>
      recovered.events.some((event) => event.type === "message"),
    );
    assert.deepEqual(
      recovered.events.find((event) => event.type === "message")!.data,
      sent,
    );
    const broadcast = await (
      await f.request("/api/messages", alice, {
        body: "all current identities",
      })
    ).json();
    const newcomer = await f.add("newcomer");
    assert.equal(f.store.pending("newcomer"), 0);
    assert.deepEqual(f.store.transcript("newcomer", "test-room"), []);
    assert.equal(f.store.inbox("carol")[0]!.id, broadcast.id);
  } finally {
    await f.stop();
  }
});

test("authentication, browser cookies, origin validation, and revocation protect live connections", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.url + "/api/state")).status, 401);
    assert.equal(
      (await fetch(f.url + "/api/state?token=" + ownerToken)).status,
      401,
    );
    assert.equal(
      (
        await fetch(f.url + "/api/state", {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    const wrongHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        httpGet(
          f.url + "/healthz",
          { headers: { Host: "attacker.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      },
    );
    assert.equal(wrongHost, 421);
    assert.equal((await fetch(f.url + "/ui/")).status, 200);
    const html = await (await fetch(f.url + "/ui/")).text();
    assert.ok(html.includes("<title>Agentwire</title>"));
    assert.ok(
      (await (await fetch(f.url + "/ui/app.js")).text()).includes(
        "new EventSource",
      ),
    );
    const login = await f.request("/api/login", ownerToken, {
      token: ownerToken,
    });
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const browser = await fetch(f.url + "/api/state", {
      headers: { Cookie: cookie.split(";")[0]! },
    });
    assert.equal(browser.status, 200);
    assert.equal(
      (
        await fetch(f.url + "/mcp", {
          headers: { Cookie: cookie.split(";")[0]! },
        })
      ).status,
      401,
    );
    const alice = await f.add("alice");
    await f.mcp(alice);
    assert.equal(
      (
        await f.request("/api/clients", alice, {
          id: "evil",
          name: "Evil",
          kind: "agent",
        })
      ).status,
      403,
    );
    const rotated = await (
      await f.request("/api/clients/alice/rotate", ownerToken, {})
    ).json();
    assert.equal((await f.request("/api/state", alice)).status, 401);
    assert.equal(f.hub.online("alice"), 0);
    assert.equal((await f.request("/api/state", rotated.token)).status, 200);
    assert.equal(
      (await f.request("/api/clients/alice", ownerToken, undefined, "DELETE"))
        .status,
      200,
    );
    assert.equal((await f.request("/api/state", rotated.token)).status, 401);
  } finally {
    await f.stop();
  }
});

test("messages, recipient snapshots, tokens, and acknowledgments survive a process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentwire-durable-"));
  const database = join(directory, "relay.db");
  let f = await fixture(database);
  try {
    const alice = await f.add("alice"),
      bob = await f.add("bob");
    const sent = await (
      await f.request("/api/messages", alice, {
        to: "bob",
        body: "Survives restart",
      })
    ).json();
    await f.stop();
    f = await fixture(database);
    const b = await f.mcp(bob);
    const inbox = toolData(
      await b.client.callTool({ name: "read_inbox", arguments: {} }),
    );
    assert.equal(inbox.messages[0].body, "Survives restart");
    assert.equal(inbox.pending, 1);
    await b.client.callTool({
      name: "acknowledge_messages",
      arguments: { ids: [sent.id] },
    });
    await f.stop();
    f = await fixture(database);
    assert.equal(f.store.pending("bob"), 0);
    f.store.joinRoom("bob", { room: "test-room" });
    assert.equal(
      f.store.transcript("bob", "test-room")[0]!.body,
      "Survives restart",
    );
    assert.equal(f.store.authenticate(alice)!.id, "alice");
  } finally {
    await f.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("large SSE replay gaps request a bounded resync; slow replay consumers keep a recoverable inbox", async () => {
  const f = await fixture();
  try {
    const alice = await f.add("alice"),
      bob = await f.add("bob");
    const actor = f.store.authenticate(alice)!;
    for (let index = 0; index < 100; index++) {
      f.store.send(actor, { to: "bob", body: `${index}:` + "x".repeat(1995) });
    }
    const replay = await f.sse(bob);
    await until(() => replay.events.some((event) => event.type === "message"));
    // More data than one response write buffer: this must never write after end
    // or mark unconsumed messages as acknowledged.
    f.store.joinRoom("bob", { room: "test-room" });
    assert.equal(f.store.pending("bob"), 100);
    replay.abort.abort();
    f.store.send(actor, { to: "bob", body: "The 101st event" });
    const gap = await f.sse(bob);
    await until(() => gap.events.some((event) => event.type === "resync"));
    assert.equal(
      gap.events.filter((event) => event.type === "message").length,
      0,
    );
    assert.equal(f.store.transcript("bob", "test-room").length, 101);
    assert.equal(f.store.inbox("bob", 100).length, 100);
    assert.equal(f.store.pending("bob"), 101);
    assert.equal((await f.request("/healthz")).status, 200);
  } finally {
    await f.stop();
  }
});
