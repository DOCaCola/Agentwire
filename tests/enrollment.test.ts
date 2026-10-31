import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, ownerToken, until } from "./support.js";
import {
  agentCredential,
  clientUrl,
  deviceCredential,
  enrollDevice,
} from "../src/device-client.js";

test("device enrollment requires human code approval, streams status without polling, and isolates device credentials from agent inboxes", async () => {
  const f = await fixture(undefined, "/relay");
  const abort = new AbortController();
  try {
    const device = {
      url: f.url + "/",
      name: "Test laptop",
      token: "aw_" + randomBytes(32).toString("base64url"),
    };
    const notices: string[] = [];
    const enrollment = enrollDevice(
      device,
      (message) => notices.push(message),
      abort.signal,
    );
    await until(() => notices.length === 1);
    const pending = await (await f.request("/api/devices")).json();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, device.name);
    assert.equal(JSON.stringify(pending).includes(device.token), false);
    assert.equal(pending[0].user_code, undefined);
    const code = /Approval code: ([A-F0-9-]+)/
      .exec(notices[0]!)![1]!
      .replace("-", "");
    assert.equal((await f.request("/api/state", device.token)).status, 401);
    assert.equal(
      (
        await f.request("/api/device/clients", device.token, {
          session: "test",
          name: "Agent",
          token_hash: createHash("sha256").update("token").digest("hex"),
        })
      ).status,
      403,
    );
    const agent = await f.add("untrusted-agent");
    assert.equal(
      (
        await f.request(`/api/devices/${pending[0].id}`, agent, {
          action: "approve",
          code,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(`/api/devices/${pending[0].id}`, ownerToken, {
          action: "approve",
          code: "00000000",
        })
      ).status,
      400,
    );
    const alice = f.store.createClient({
      id: "alice",
      name: "Alice",
      kind: "human",
    });
    assert.equal(
      (
        await f.request(`/api/devices/${pending[0].id}`, alice.token, {
          action: "approve",
          code,
        })
      ).status,
      200,
    );
    await enrollment;
    assert.match(notices[1]!, /approved/);
    assert.equal(
      f.requests.filter((r) => r.path === "/relay/api/enrollment/events")
        .length,
      1,
    );
    const a = await agentCredential(device, "Agent A", abort.signal, "a");
    const b = await agentCredential(device, "Agent B", abort.signal, "b");
    const again = await agentCredential(device, "Agent A", abort.signal, "a");
    assert.deepEqual(again, a);
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.client.id, b.client.id);
    const sent = await (
      await f.request("/api/messages", a.token, {
        to: b.client.id,
        body: "Private device-session message",
      })
    ).json();
    assert.equal(
      (await (await f.request("/api/inbox", b.token)).json()).messages[0].id,
      sent.id,
    );
    assert.equal(
      (await (await f.request("/api/state", alice.token)).json()).messages
        .length,
      0,
    );
    const bob = f.store.createClient({ id: "bob", name: "Bob", kind: "human" });
    assert.equal(
      (await (await f.request("/api/devices", bob.token)).json()).length,
      0,
    );
    assert.equal(
      (
        await f.request(`/api/devices/${pending[0].id}`, bob.token, {
          action: "revoke",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.request(`/api/clients/${a.client.id}/rotate`, ownerToken, {}))
        .status,
      400,
    );
    const live = await f.sse(b.token);
    assert.equal(
      (
        await f.request(`/api/devices/${pending[0].id}`, alice.token, {
          action: "revoke",
        })
      ).status,
      200,
    );
    assert.equal((await f.request("/api/state", a.token)).status, 401);
    assert.equal((await f.request("/api/state", b.token)).status, 401);
    await assert.rejects(agentCredential(device, "No", abort.signal), /403/);
    live.abort.abort();
    await assert.rejects(
      enrollDevice(device, () => {}, abort.signal),
      /403/,
    );
  } finally {
    abort.abort();
    await f.stop();
  }
});

test("pending devices expire and denial, hash-only impersonation, reserved fields, and unbounded queues are rejected", async () => {
  const f = await fixture();
  try {
    const token = "aw_" + randomBytes(32).toString("base64url");
    const token_hash = createHash("sha256").update(token).digest("hex");
    const response = await f.request("/api/enrollment", "", {
      name: "New device",
      token_hash,
    });
    assert.equal(response.status, 201);
    const device = await response.json();
    assert.equal(
      (
        await f.request("/api/enrollment", "", {
          name: "Spoof",
          token_hash,
          admin: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(f.url + "/api/enrollment/events", {
          headers: { Authorization: "Bearer " + token_hash },
        })
      ).status,
      401,
    );
    f.store.db
      .prepare("UPDATE devices SET expires_at=? WHERE id=?")
      .run(Date.now() - 1, device.id);
    f.identities.expire();
    assert.equal(
      (
        await f.request(`/api/devices/${device.id}`, ownerToken, {
          action: "approve",
          code: device.user_code,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/api/enrollment", "", { name: "Expired", token_hash }))
        .status,
      403,
    );
    for (let i = 0; i < 20; i++)
      assert.equal(
        (
          await f.request("/api/enrollment", "", {
            name: "Pending",
            token_hash: randomBytes(32).toString("hex"),
          })
        ).status,
        201,
      );
    assert.equal(
      (
        await f.request("/api/enrollment", "", {
          name: "Overflow",
          token_hash: randomBytes(32).toString("hex"),
        })
      ).status,
      429,
    );
  } finally {
    await f.stop();
  }
});

test("concurrent device setup persists a single private credential and stable session credentials survive relay restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentwire-device-"));
  let f = await fixture(join(directory, "relay.db"));
  const abort = new AbortController();
  try {
    const url = clientUrl(f.url);
    const devices = await Promise.all(
      Array.from({ length: 8 }, () =>
        deviceCredential(url, join(directory, "credentials"), "Laptop"),
      ),
    );
    assert.ok(devices.every((device) => device.token === devices[0]!.token));
    const files = await readdir(join(directory, "credentials"));
    assert.equal(files.length, 1);
    assert.equal(
      (await stat(join(directory, "credentials", files[0]!))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(join(directory, "credentials"))).mode & 0o777,
      0o700,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(directory, "credentials", files[0]!), "utf8"),
      ).token,
      devices[0]!.token,
    );
    const device = devices[0]!;
    const pending = await (
      await f.request("/api/enrollment", "", {
        name: device.name,
        token_hash: createHash("sha256").update(device.token).digest("hex"),
      })
    ).json();
    await f.request(`/api/devices/${pending.id}`, ownerToken, {
      action: "approve",
      code: pending.user_code,
    });
    const a = await agentCredential(
      device,
      "Durable",
      abort.signal,
      "stable-chat",
    );
    const message = await (
      await f.request("/api/messages", ownerToken, {
        to: a.client.id,
        body: "Survives restart",
      })
    ).json();
    await f.stop();
    f = await fixture(join(directory, "relay.db"));
    const restored = await agentCredential(
      { ...device, url: f.url + "/" },
      "Durable",
      abort.signal,
      "stable-chat",
    );
    assert.equal(restored.token, a.token);
    assert.equal(restored.client.id, a.client.id);
    assert.equal(
      (await (await f.request("/api/inbox", a.token)).json()).messages[0].id,
      message.id,
    );
  } finally {
    abort.abort();
    await f.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
