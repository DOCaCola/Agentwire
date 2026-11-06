import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { participantName, roomName } from "./protocol.js";
import { hashToken, Problem, type Client, type Store } from "./store.js";

export type Device = {
  id: string;
  name: string;
  fingerprint: string;
  status: "pending" | "approved" | "denied" | "revoked" | "expired";
  owner_id: string | null;
  expires_at: number;
  created_at: string;
};
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sessionFields = {
  session: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(80),
  token_hash: digest,
};

/** Enrollment credentials can enroll agents, but cannot read or send messages. */
export class IdentityStore {
  constructor(private store: Store) {}
  human(issuer: string, subject: string, name: string, admin: boolean): Client {
    const account = this.store.db
      .prepare(
        "SELECT client_id FROM oidc_accounts WHERE issuer=? AND subject=?",
      )
      .get(issuer, subject) as { client_id: string } | undefined;
    if (account) {
      if (!this.store.client(account.client_id))
        throw new Problem(403, "Account revoked");
      this.store.db
        .prepare("UPDATE clients SET name=?,admin=? WHERE id=?")
        .run(name.slice(0, 80), Number(admin), account.client_id);
      return this.store.client(account.client_id)!;
    }
    const id = "person-" + randomBytes(10).toString("hex");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.store.clients().length >= 1000)
        throw new Problem(409, "Client limit reached (1000)");
      this.store.db
        .prepare(
          "INSERT INTO clients(id,name,kind,admin) VALUES (?,?,'human',?)",
        )
        .run(id, name.slice(0, 80), Number(admin));
      this.store.db
        .prepare(
          "INSERT INTO oidc_accounts(issuer,subject,client_id) VALUES (?,?,?)",
        )
        .run(issuer, subject, id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.store.client(id)!;
  }
  isOidc(id: string) {
    return Boolean(
      this.store.db
        .prepare("SELECT client_id FROM oidc_accounts WHERE client_id=?")
        .get(id),
    );
  }
  isDeviceClient(id: string) {
    return Boolean(
      this.store.db
        .prepare("SELECT client_id FROM device_clients WHERE client_id=?")
        .get(id),
    );
  }
  private select =
    "SELECT id,name,substr(token_hash,1,16) AS fingerprint,status,owner_id,expires_at,created_at FROM devices";
  device(id: string): Device | undefined {
    return this.store.db.prepare(this.select + " WHERE id=?").get(id) as
      Device | undefined;
  }
  credential(token: string): Device | undefined {
    return this.store.db
      .prepare(this.select + " WHERE token_hash=?")
      .get(hashToken(token)) as Device | undefined;
  }
  enroll(input: unknown): Device & { user_code: string } {
    const data = z
      .object({ name: z.string().trim().min(1).max(80), token_hash: digest })
      .strict()
      .parse(input);
    const existing = this.store.db
      .prepare("SELECT id,user_code FROM devices WHERE token_hash=?")
      .get(data.token_hash) as { id: string; user_code: string } | undefined;
    if (existing) {
      const device = this.device(existing.id)!;
      if (["denied", "revoked", "expired"].includes(device.status))
        throw new Problem(
          403,
          "Device enrollment is no longer valid; reset this device credential to enroll again",
        );
      return { ...device, user_code: existing.user_code };
    }
    const active = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM devices WHERE status IN ('pending','approved')",
      )
      .get() as { count: number };
    if (active.count >= 100)
      throw new Problem(429, "Device limit reached (100)");
    const pending = this.store.db
      .prepare("SELECT COUNT(*) AS count FROM devices WHERE status='pending'")
      .get() as { count: number };
    if (pending.count >= 20) throw new Problem(429, "Too many pending devices");
    const id = randomUUID();
    const code = randomBytes(4).toString("hex").toUpperCase();
    this.store.db
      .prepare(
        "INSERT INTO devices(id,name,token_hash,user_code,status,expires_at) VALUES (?,?,?,?,'pending',?)",
      )
      .run(id, data.name, data.token_hash, code, Date.now() + 10 * 60_000);
    return { ...this.device(id)!, user_code: code };
  }
  devices(actor: Client): Device[] {
    return this.store.db
      .prepare(
        this.select +
          (actor.admin
            ? " WHERE status IN ('pending','approved')"
            : " WHERE status='pending' OR (status='approved' AND owner_id=?)") +
          " ORDER BY created_at DESC",
      )
      .all(...(actor.admin ? [] : [actor.id])) as Device[];
  }
  decide(actor: Client, id: string, input: unknown): Device {
    const data = z
      .object({
        action: z.enum(["approve", "deny", "revoke"]),
        code: z.string().max(8).optional(),
      })
      .strict()
      .parse(input);
    const device = this.device(id);
    if (!device) throw new Problem(404, "Device not found");
    if (data.action === "revoke") {
      if (
        device.status !== "approved" ||
        (!actor.admin && device.owner_id !== actor.id)
      )
        throw new Problem(403, "Device is not yours");
    } else {
      if (device.status !== "pending" || device.expires_at <= Date.now())
        throw new Problem(409, "Enrollment is no longer pending");
      const row = this.store.db
        .prepare("SELECT user_code FROM devices WHERE id=?")
        .get(id) as { user_code: string };
      if (
        data.action === "approve" &&
        data.code?.toUpperCase() !== row.user_code
      )
        throw new Problem(
          400,
          "Enter the approval code displayed on the device",
        );
    }
    const status =
      data.action === "approve"
        ? "approved"
        : data.action === "deny"
          ? "denied"
          : "revoked";
    this.store.db
      .prepare("UPDATE devices SET status=?,owner_id=? WHERE id=?")
      .run(status, device.owner_id ?? actor.id, id);
    return this.device(id)!;
  }
  /**
   * Maps a device-local session, such as a Codex thread, to one stable agent identity.
   * Without create, an unknown session yields null so lookups never mint identities.
   */
  private authorize(device: Device) {
    if (
      device.status !== "approved" ||
      !device.owner_id ||
      !this.store.client(device.owner_id)
    )
      throw new Problem(403, "Device is not authorized");
  }
  private mapped(device: Device, session: string) {
    return this.store.db
      .prepare(
        "SELECT client_id FROM device_clients WHERE device_id=? AND session_key=?",
      )
      .get(device.id, session) as { client_id: string } | undefined;
  }
  session(device: Device, input: unknown): Client | null {
    this.authorize(device);
    const data = z
      .object({ ...sessionFields, create: z.boolean() })
      .strict()
      .parse(input);
    const existing = this.mapped(device, data.session);
    if (existing) {
      const client = this.store.client(existing.client_id);
      if (!client) throw new Problem(403, "Agent session revoked");
      const hash = this.store.db
        .prepare("SELECT token_hash FROM clients WHERE id=?")
        .get(client.id) as { token_hash: string };
      if (hash.token_hash !== data.token_hash)
        throw new Problem(409, "Session credential does not match");
      return client;
    }
    if (!data.create) return null;
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM device_clients dc JOIN clients c ON c.id=dc.client_id WHERE dc.device_id=? AND c.revoked=0",
      )
      .get(device.id) as { count: number };
    if (count.count >= 100 || this.store.clients().length >= 1000)
      throw new Problem(409, "Agent client limit reached");
    const id = "agent-" + randomBytes(10).toString("hex");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          "INSERT INTO clients(id,name,kind,token_hash) VALUES (?,?,'agent',?)",
        )
        .run(id, data.name, data.token_hash);
      this.store.db
        .prepare(
          "INSERT INTO device_clients(device_id,session_key,client_id) VALUES (?,?,?)",
        )
        .run(device.id, data.session, id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.store.client(id)!;
  }
  /**
   * Moves an agent identity, with its room name and inbox, to another device session, such as
   * a forked or handed-off thread. Only agents on approved devices of the same person qualify.
   * The session that held it loses it; a participant the adopting session held before is retired.
   */
  adopt(
    device: Device,
    input: unknown,
  ): { client: Client; replaced: string | null } {
    this.authorize(device);
    const data = z
      .object({
        ...sessionFields,
        room: roomName,
        participant: participantName,
      })
      .strict()
      .parse(input);
    const target = this.store.db
      .prepare(
        `SELECT m.client_id FROM room_memberships m
        JOIN device_clients dc ON dc.client_id=m.client_id JOIN devices d ON d.id=dc.device_id
        JOIN clients c ON c.id=m.client_id
        WHERE m.room=? AND m.name=? COLLATE NOCASE AND d.owner_id=? AND d.status='approved' AND c.revoked=0`,
      )
      .get(data.room, data.participant, device.owner_id) as
      { client_id: string } | undefined;
    if (!target)
      throw new Problem(
        404,
        `None of your agents is named "${data.participant}" in room "${data.room}"`,
      );
    const current = this.mapped(device, data.session)?.client_id ?? null;
    if (current === target.client_id)
      return { client: this.store.client(current)!, replaced: null };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (current) {
        // The retired identity stays attributed to this device for message history.
        this.store.revoke(current);
        this.store.db
          .prepare(
            "UPDATE device_clients SET session_key='retired:'||client_id WHERE client_id=?",
          )
          .run(current);
      }
      this.store.db
        .prepare(
          "UPDATE device_clients SET device_id=?,session_key=? WHERE client_id=?",
        )
        .run(device.id, data.session, target.client_id);
      this.store.db
        .prepare("UPDATE clients SET name=?,token_hash=? WHERE id=?")
        .run(data.name, data.token_hash, target.client_id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return { client: this.store.client(target.client_id)!, replaced: current };
  }
  children(id: string): string[] {
    return (
      this.store.db
        .prepare("SELECT client_id FROM device_clients WHERE device_id=?")
        .all(id) as { client_id: string }[]
    ).map((row) => row.client_id);
  }
  owned(actor: Client, id: string): boolean {
    return Boolean(
      actor.admin ||
      this.store.db
        .prepare(
          "SELECT dc.client_id FROM device_clients dc JOIN devices d ON d.id=dc.device_id WHERE dc.client_id=? AND d.owner_id=?",
        )
        .get(id, actor.id),
    );
  }
  expire(): string[] {
    const expired = this.store.db
      .prepare(
        "SELECT id FROM devices WHERE status='pending' AND expires_at<=?",
      )
      .all(Date.now()) as { id: string }[];
    this.store.db
      .prepare(
        "UPDATE devices SET status='expired' WHERE status='pending' AND expires_at<=?",
      )
      .run(Date.now());
    // Expired requests carry no authority or message history. Bound unauthenticated storage.
    this.store.db
      .prepare(
        "DELETE FROM devices WHERE status IN ('expired','denied') AND expires_at<? AND NOT EXISTS (SELECT 1 FROM device_clients WHERE device_id=devices.id)",
      )
      .run(Date.now() - 24 * 60 * 60_000);
    return expired.map((row) => row.id);
  }
}
