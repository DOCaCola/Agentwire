import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, toolData, until } from "./support.js";

test("only explicit room participants can discover, address, receive, reply to or acknowledge each other", async () => {
  const f = await fixture();
  try {
    const alice = await f.add("alice", null),
      bob = await f.add("bob", null),
      carol = await f.add("carol", null),
      idle = await f.add("idle", null);
    const launched = await f.mcp(idle, null);
    assert.equal(
      (await launched.client.callTool({ name: "list_clients", arguments: {} }))
        .isError,
      true,
    );
    assert.equal(
      (await f.request("/api/messages", idle, { body: "not joined" })).status,
      409,
    );
    const empty = await (await f.request("/api/state", idle)).json();
    assert.deepEqual(empty.chats, []);
    assert.equal(empty.membership, null);
    assert.equal(
      (await f.request("/api/rooms/join", alice, { room: "MyTask" })).status,
      200,
    );
    await f.request("/api/rooms/join", bob, { room: "MyTask" });
    await f.request("/api/rooms/join", carol, { room: "OtherTask" });
    assert.deepEqual(
      (await (await f.request("/api/clients", alice)).json()).map(
        (c: { id: string }) => c.id,
      ),
      ["alice", "bob"],
    );
    for (const to of ["carol", "idle", "owner"])
      assert.equal(
        (await f.request("/api/messages", alice, { to, body: "wrong room" }))
          .status,
        404,
      );
    const broadcast = await (
      await f.request("/api/messages", alice, {
        body: "room only",
        idempotency_key: "once",
      })
    ).json();
    assert.equal(broadcast.room, "MyTask");
    assert.equal(f.store.pending("bob"), 1);
    assert.equal(f.store.pending("carol"), 0);
    assert.equal(f.store.pending("idle"), 0);
    assert.deepEqual(launched.notifications, []);
    await f.request("/api/rooms/join", carol, { room: "MyTask" });
    assert.deepEqual(
      f.store.transcript("carol", "MyTask"),
      [],
      "joining later cannot read previous broadcasts",
    );
    const reply = await (
      await f.request("/api/messages", bob, {
        to: "alice",
        body: "received",
        reply_to: broadcast.id,
      })
    ).json();
    await f.request("/api/rooms/join", alice, { room: "OtherTask" });
    assert.deepEqual(
      (await (await f.request("/api/inbox", alice)).json()).messages,
      [],
    );
    assert.equal(
      (await f.request("/api/ack", alice, { ids: [reply.id] })).status,
      404,
    );
    assert.equal(
      (
        await f.request("/api/messages", alice, {
          body: "reference",
          reply_to: broadcast.id,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request("/api/messages", alice, {
          body: "room only",
          idempotency_key: "once",
        })
      ).status,
      409,
      "retry keys cannot replay another room's message",
    );
    await f.request("/api/rooms/join", alice, { room: "MyTask" });
    assert.equal(
      (await (await f.request("/api/inbox", alice)).json()).messages[0].id,
      reply.id,
    );
    await f.request("/api/rooms/leave", bob, {});
    assert.equal((await f.request("/api/clients", bob)).status, 409);
    assert.equal(
      (await f.request("/api/messages", alice, { to: "bob", body: "left" }))
        .status,
      404,
    );
    assert.equal(
      (await f.request("/api/rooms/heartbeat", bob, { room: "MyTask" })).status,
      409,
      "heartbeats cannot join a room",
    );
  } finally {
    await f.stop();
  }
});

test("disconnected and lapsed participants stay members as away and keep receiving", async () => {
  const f = await fixture();
  try {
    const alice = await f.add("alice", "MyTask"),
      bob = await f.add("bob", "MyTask");
    const b = await f.mcp(bob, "MyTask");
    await f.request("/api/messages", alice, { to: "bob", body: "durable" });
    await until(() => b.notifications.length === 1);
    await b.client.close();
    await until(() => f.hub.online("bob") === 0);
    assert.deepEqual(f.store.membership("bob"), {
      room: "MyTask",
      name: "BOB",
      active: false,
    });
    assert.deepEqual(
      f.store.participants("alice").map((c) => [c.name, c.status]),
      [
        ["ALICE", "active"],
        ["BOB", "away"],
      ],
    );
    assert.equal(
      (await f.request("/api/messages", alice, { to: "bob", body: "offline" }))
        .status,
      201,
    );
    assert.deepEqual(
      f.store.inbox("bob").map((message) => message.body),
      ["durable", "offline"],
    );
    assert.equal(
      (await f.request("/api/rooms/heartbeat", bob, { room: "WrongTask" }))
        .status,
      409,
    );
    await f.request("/api/rooms/heartbeat", bob, { room: "MyTask" });
    assert.equal(f.store.membership("bob")!.active, true);
    // A lapsed lease is announced once and leaves the membership in place.
    f.store.expireRooms();
    f.store.db
      .prepare("UPDATE room_memberships SET expires_at=? WHERE client_id='bob'")
      .run(Date.now() + 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.store.expireRooms(), true);
    assert.equal(f.store.expireRooms(), false);
    assert.equal(f.store.membership("bob")!.active, false);
    // Memberships away for over a week are removed.
    f.store.db
      .prepare("UPDATE room_memberships SET expires_at=? WHERE client_id='bob'")
      .run(Date.now() - 8 * 24 * 60 * 60_000);
    assert.equal(f.store.expireRooms(), true);
    assert.equal(f.store.membership("bob"), null);
  } finally {
    await f.stop();
  }
});

test("participants choose a name per room and messages keep the names used when sent", async () => {
  const f = await fixture();
  try {
    const alice = await f.add("alice", null),
      bob = await f.add("bob", null);
    const joined = await (
      await f.request("/api/rooms/join", alice, {
        room: "MyTask",
        name: "Planner",
      })
    ).json();
    assert.equal(joined.name, "Planner");
    await f.request("/api/rooms/join", bob, { room: "MyTask" });
    assert.deepEqual(
      (await (await f.request("/api/clients", bob)).json()).map(
        (p: { id: string; name: string; client_name: string }) => [
          p.id,
          p.name,
          p.client_name,
        ],
      ),
      [
        ["bob", "BOB", "BOB"],
        ["alice", "Planner", "ALICE"],
      ],
    );
    const sent = await (
      await f.request("/api/messages", bob, { to: "PLANNER", body: "hi" })
    ).json();
    assert.equal(sent.sender_name, "BOB");
    assert.equal(sent.recipient_name, "Planner");
    assert.equal(
      (await f.request("/api/messages", bob, { to: "alice", body: "hi" }))
        .status,
      404,
      "participants are addressed by room name",
    );
    assert.equal(
      (await f.request("/api/messages", bob, { to: "bob", body: "me" })).status,
      400,
    );
    const taken = await f.request("/api/rooms/join", bob, {
      room: "MyTask",
      name: "planner",
    });
    assert.equal(taken.status, 409);
    assert.match((await taken.json()).error, /"planner" is taken/);
    assert.equal(
      (
        await f.request("/api/rooms/join", bob, {
          room: "MyTask",
          name: "All",
        })
      ).status,
      400,
    );
    // Answering a message acknowledges it for the replying participant.
    const answer = await (
      await f.request("/api/messages", alice, {
        to: "bob",
        body: "thanks",
        reply_to: sent.id,
      })
    ).json();
    assert.equal(answer.reply_to, sent.id);
    assert.equal(f.store.pending("alice"), 0);
    await f.request("/api/rooms/join", alice, { room: "MyTask" });
    assert.equal(f.store.membership("alice")!.name, "Planner");
    await f.request("/api/rooms/join", alice, {
      room: "MyTask",
      name: "Reviewer",
    });
    assert.equal(
      f.store.transcript("alice", "MyTask")[0]!.recipient_name,
      "Planner",
    );
    assert.equal(
      f.store.participants("bob").find((p) => p.id === "alice")!.name,
      "Reviewer",
    );
    await f.request("/api/rooms/join", alice, { room: "Other" });
    assert.equal(f.store.membership("alice")!.name, "ALICE");
    assert.equal(
      (
        await f.request("/api/rooms/join", alice, {
          room: "Other",
          name: "bad\u0007",
        })
      ).status,
      400,
    );
  } finally {
    await f.stop();
  }
});

test("MCP room joins return discoverable peers, switch atomically and reject unjoined tools", async () => {
  const f = await fixture();
  try {
    await f.add("peer", "MyTask");
    const token = await f.add("agent", null),
      agent = await f.mcp(token, null);
    assert.equal(
      (await agent.client.callTool({ name: "read_inbox", arguments: {} }))
        .isError,
      true,
    );
    const joined = toolData(
      await agent.client.callTool({
        name: "join_room",
        arguments: { room: "MyTask" },
      }),
    );
    assert.equal(joined.room, "MyTask");
    assert.deepEqual(joined.participants, [
      { name: "AGENT", kind: "agent", client_name: "AGENT", status: "active" },
      { name: "PEER", kind: "agent", client_name: "PEER", status: "active" },
    ]);
    const switched = toolData(
      await agent.client.callTool({
        name: "join_room",
        arguments: { room: "New Task" },
      }),
    );
    assert.deepEqual(
      switched.participants.map((p: { name: string }) => p.name),
      ["AGENT"],
    );
    await agent.client.callTool({ name: "leave_room", arguments: {} });
    assert.equal(f.store.room("agent"), undefined);
    assert.equal(
      (await agent.client.callTool({ name: "list_clients", arguments: {} }))
        .isError,
      true,
    );
    assert.equal(
      (
        await agent.client.callTool({
          name: "join_room",
          arguments: { room: "../bad" },
        })
      ).isError,
      true,
    );
  } finally {
    await f.stop();
  }
});

test(
  "an idle HTTP MCP participant renews presence with protocol ping/pong without inbox polling",
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const token = await f.add("idle", null);
      await f.mcp(token, "MyTask");
      const expiry = () =>
        Number(
          f.store.db
            .prepare(
              "SELECT expires_at FROM room_memberships WHERE client_id='idle'",
            )
            .get()!.expires_at,
        );
      const initial = expiry();
      await until(() => expiry() > initial + 15_000, 25_000);
      assert.equal(f.store.room("idle"), "MyTask");
      assert.equal(
        f.requests.filter((request) => request.path.startsWith("/api/inbox"))
          .length,
        0,
      );
    } finally {
      await f.stop();
    }
  },
);

test("version 2 databases retain historical messages without exposing them in a default room", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentwire-v2-"));
  const database = join(directory, "relay.db");
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,token_hash TEXT UNIQUE,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT 'legacy');
    INSERT INTO clients(id,name,kind,admin) VALUES ('owner','Owner','human',1);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT NOT NULL REFERENCES clients(id),recipient TEXT REFERENCES clients(id),channel TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,reply_to INTEGER REFERENCES messages(id),idempotency_key TEXT,request_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT 'legacy',UNIQUE(sender,idempotency_key));
    INSERT INTO messages(sender,channel,body,kind,request_json) VALUES ('owner','general','Legacy broadcast','note','{}');
    PRAGMA user_version=2;
  `);
  legacy.close();
  const f = await fixture(database);
  try {
    assert.equal(
      f.store.db.prepare("PRAGMA user_version").get()!.user_version,
      5,
    );
    assert.throws(
      () => f.store.db.prepare("SELECT kind FROM messages").get(),
      /no such column/,
    );
    assert.deepEqual(f.store.latest("owner"), []);
    const old = f.store.db.prepare("SELECT body,room FROM messages").get()!;
    assert.equal(old.body, "Legacy broadcast");
    assert.equal(old.room, null);
  } finally {
    await f.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
