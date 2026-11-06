import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clientId, sendSchema, joinSchema } from "./protocol.js";
export type SendInput = z.input<typeof sendSchema>;
export type Client = {
  id: string;
  name: string;
  kind: string;
  admin: number;
  revoked: number;
  created_at: string;
};
/** A room membership; the name is how this client appears inside that room. */
export type Membership = { room: string; name: string; active: boolean };
/** Away participants are disconnected members; they keep their name and receive messages. */
export type Status = "active" | "away";
export type Participant = {
  id: string;
  name: string;
  kind: string;
  client_name: string;
  status: Status;
};
export type Message = {
  id: number;
  sender: string;
  sender_name: string;
  recipient: string | null;
  recipient_name: string | null;
  room: string | null;
  channel: string;
  body: string;
  reply_to: number | null;
  created_at: string;
};
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const newToken = () => `aw_${randomBytes(32).toString("base64url")}`;
/** Memberships of clients that never return are removed after a week away. */
const awayRetention = 7 * 24 * 60 * 60_000;
const lease = 60_000;

const columns =
  "m.id,m.sender,m.sender_name,m.recipient,m.recipient_name,m.room,m.channel,m.body,m.reply_to,m.created_at";
const owned =
  "SELECT :actor UNION SELECT dc.client_id FROM device_clients dc JOIN devices d ON d.id=dc.device_id WHERE d.owner_id=:actor";
/**
 * Agents see their current room's messages that they sent or received.
 * People see every message sent or received by themselves or by agents on devices they approved.
 * Nobody, including the owner, reads other identities' direct messages.
 */
const visible = `CASE (SELECT kind FROM clients WHERE id=:actor)
  WHEN 'human' THEN m.room IS NOT NULL AND (m.sender IN (${owned})
    OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.client_id IN (${owned})))
  ELSE m.room=(SELECT room FROM room_memberships WHERE client_id=:actor)
    AND (m.sender=:actor OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.client_id=:actor))
  END`;

export class Store {
  readonly db: DatabaseSync;
  /** Lease expiries up to this time have already been announced. */
  private expiredUntil = Date.now();
  constructor(path: string, adminToken: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        admin INTEGER NOT NULL DEFAULT 0, token_hash TEXT UNIQUE,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL REFERENCES clients(id),
        recipient TEXT REFERENCES clients(id), channel TEXT NOT NULL, body TEXT NOT NULL,
        kind TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id),
        idempotency_key TEXT, request_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(sender, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        client_id TEXT NOT NULL REFERENCES clients(id), acked_at TEXT,
        PRIMARY KEY(message_id, client_id)
      );
      CREATE INDEX IF NOT EXISTS inbox ON deliveries(client_id, acked_at, message_id);
      CREATE TABLE IF NOT EXISTS oidc_accounts (
        issuer TEXT NOT NULL, subject TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE REFERENCES clients(id),
        PRIMARY KEY (issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        user_code TEXT NOT NULL, status TEXT NOT NULL,
        owner_id TEXT REFERENCES clients(id), expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS device_clients (
        device_id TEXT NOT NULL REFERENCES devices(id),
        session_key TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE REFERENCES clients(id),
        PRIMARY KEY (device_id, session_key)
      );
    `);
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version < 3) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE messages ADD COLUMN room TEXT;
        CREATE TABLE room_memberships (
          client_id TEXT PRIMARY KEY REFERENCES clients(id),
          room TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX room_participants ON room_memberships(room, expires_at);
        PRAGMA user_version=3;
        COMMIT;`);
    }
    if (version < 4) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE room_memberships ADD COLUMN name TEXT NOT NULL DEFAULT '';
        UPDATE room_memberships SET name=(SELECT name FROM clients WHERE id=client_id);
        ALTER TABLE messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE messages ADD COLUMN recipient_name TEXT;
        UPDATE messages SET sender_name=(SELECT name FROM clients WHERE id=sender),
          recipient_name=(SELECT name FROM clients WHERE id=recipient);
        CREATE INDEX room_messages ON messages(room, id);
        PRAGMA user_version=4;
        COMMIT;`);
    }
    if (version < 5) {
      // Names become unique per room. The most recently present holder of a name keeps it;
      // older duplicates, which are away members from earlier sessions, leave the room.
      this.db.exec(`BEGIN IMMEDIATE;
        DELETE FROM room_memberships WHERE client_id IN (
          SELECT client_id FROM (SELECT client_id, ROW_NUMBER() OVER (
            PARTITION BY room, lower(name) ORDER BY expires_at DESC, client_id) AS rank
          FROM room_memberships) WHERE rank>1);
        ALTER TABLE messages DROP COLUMN kind;
        CREATE UNIQUE INDEX room_names ON room_memberships(room, name COLLATE NOCASE);
        PRAGMA user_version=5;
        COMMIT;`);
    }
    // A relay restart cannot prove that previous participants are still alive.
    this.db
      .prepare("UPDATE room_memberships SET expires_at=MIN(expires_at,?)")
      .run(this.expiredUntil);
    this.db
      .prepare(
        `INSERT INTO clients(id,name,kind,admin,token_hash) VALUES ('owner','Owner','human',1,?)
      ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
      )
      .run(hashToken(adminToken));
  }

  authenticate(token: string): Client | undefined {
    return this.db
      .prepare(
        "SELECT id,name,kind,admin,revoked,created_at FROM clients WHERE token_hash=? AND revoked=0",
      )
      .get(hashToken(token)) as Client | undefined;
  }
  client(id: string): Client | undefined {
    return this.db
      .prepare(
        "SELECT id,name,kind,admin,revoked,created_at FROM clients WHERE id=? AND revoked=0",
      )
      .get(id) as Client | undefined;
  }
  clients(): Client[] {
    return this.db
      .prepare(
        "SELECT id,name,kind,admin,revoked,created_at FROM clients WHERE revoked=0 ORDER BY admin DESC,name",
      )
      .all() as Client[];
  }
  /** The room the actor belongs to, whether active or away. */
  room(actor: string): string | undefined {
    return this.membership(actor)?.room;
  }
  /** The current membership, including an away one that its client renews on reconnect. */
  membership(actor: string): Membership | null {
    const row = this.db
      .prepare(
        "SELECT room,name,expires_at>? AS active FROM room_memberships WHERE client_id=?",
      )
      .get(Date.now(), actor) as
      { room: string; name: string; active: number } | undefined;
    return row
      ? { room: row.room, name: row.name, active: !!row.active }
      : null;
  }
  requireRoom(actor: string): string {
    const room = this.room(actor);
    if (!room)
      throw new Problem(
        409,
        "Join a task room with join_room before messaging or discovering participants",
      );
    return room;
  }
  /**
   * Joining sets the room name; rejoining the same room without a name keeps the current one.
   * Device agents default to their device name, other clients to their client name.
   */
  joinRoom(actor: string, input: unknown): { room: string; name: string } {
    const data = joinSchema.parse(input);
    const client = this.client(actor);
    if (!client) throw new Problem(401, "Client revoked");
    const current = this.membership(actor);
    const device = this.db
      .prepare(
        "SELECT d.name FROM device_clients dc JOIN devices d ON d.id=dc.device_id WHERE dc.client_id=?",
      )
      .get(actor) as { name: string } | undefined;
    const name =
      data.name ??
      (current?.room === data.room
        ? current.name
        : (device?.name ?? client.name));
    const holder = this.db
      .prepare(
        "SELECT expires_at>? AS active FROM room_memberships WHERE room=? AND name=? COLLATE NOCASE AND client_id<>?",
      )
      .get(Date.now(), data.room, name, actor) as
      { active: number } | undefined;
    if (holder)
      throw new Problem(
        409,
        `The name "${name}" is taken in room "${data.room}" by ${holder.active ? "an active" : "an away"} participant. Join with another name. Only if the user asks this thread to continue as that participant, adopt it with adopt_participant.`,
      );
    this.db
      .prepare(
        `INSERT INTO room_memberships(client_id,room,name,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET room=excluded.room,name=excluded.name,expires_at=excluded.expires_at`,
      )
      .run(actor, data.room, name, Date.now() + lease);
    return { room: data.room, name };
  }
  leaveRoom(actor: string): void {
    this.db
      .prepare("DELETE FROM room_memberships WHERE client_id=?")
      .run(actor);
  }
  renewRoom(actor: string, room: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE room_memberships SET expires_at=? WHERE client_id=? AND room=?",
          )
          .run(Date.now() + lease, actor, room).changes,
      ) > 0
    );
  }
  /** Marks the membership away from now on; the member keeps its name and inbox. */
  suspendRoom(actor: string): void {
    this.db
      .prepare(
        "UPDATE room_memberships SET expires_at=MIN(expires_at,?) WHERE client_id=?",
      )
      .run(Date.now(), actor);
  }
  /** Reports whether any lease lapsed or away membership was removed since the last call. */
  expireRooms(): boolean {
    const now = Date.now();
    const lapsed = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM room_memberships WHERE expires_at>? AND expires_at<=?",
      )
      .get(this.expiredUntil, now) as { count: number };
    this.expiredUntil = now;
    const removed = this.db
      .prepare("DELETE FROM room_memberships WHERE expires_at<?")
      .run(now - awayRetention).changes;
    return lapsed.count > 0 || Number(removed) > 0;
  }
  /** Participants of every room, as they named themselves in that room. */
  presence(): (Participant & { room: string })[] {
    return this.db
      .prepare(
        `SELECT r.room,c.id,r.name,c.kind,c.name AS client_name,
        CASE WHEN r.expires_at>? THEN 'active' ELSE 'away' END AS status FROM clients c
      JOIN room_memberships r ON r.client_id=c.id WHERE c.revoked=0
      ORDER BY r.room,r.name COLLATE NOCASE,c.id LIMIT 1000`,
      )
      .all(Date.now()) as (Participant & { room: string })[];
  }
  participants(actor: string): Participant[] {
    const room = this.room(actor);
    return this.presence()
      .filter((item) => item.room === room)
      .map(({ room: _room, ...participant }) => participant);
  }
  createClient(input: unknown): { client: Client; token: string } {
    const data = z
      .object({
        id: clientId.refine(
          (id) => id !== "all" && id !== "owner",
          "Reserved ID",
        ),
        name: z.string().trim().min(1).max(80),
        kind: z.enum(["agent", "human"]),
      })
      .strict()
      .parse(input);
    if (this.db.prepare("SELECT id FROM clients WHERE id=?").get(data.id))
      throw new Problem(409, "Client ID already exists");
    if (this.clients().length >= 1000)
      throw new Problem(409, "Client limit reached (1000)");
    const token = newToken();
    this.db
      .prepare("INSERT INTO clients(id,name,kind,token_hash) VALUES (?,?,?,?)")
      .run(data.id, data.name, data.kind, hashToken(token));
    return { client: this.client(data.id)!, token };
  }
  rotate(id: string): string {
    if (id === "owner")
      throw new Problem(
        400,
        "Rotate the owner token through AGENTWIRE_ADMIN_TOKEN",
      );
    if (!this.client(id)) throw new Problem(404, "Client not found");
    const token = newToken();
    this.db
      .prepare("UPDATE clients SET token_hash=? WHERE id=?")
      .run(hashToken(token), id);
    return token;
  }
  revoke(id: string): void {
    if (id === "owner") throw new Problem(400, "The owner cannot be revoked");
    if (!this.client(id)) throw new Problem(404, "Client not found");
    this.leaveRoom(id);
    this.db
      .prepare("UPDATE clients SET revoked=1,token_hash=NULL WHERE id=?")
      .run(id);
  }
  message(actor: string, id: number): Message | undefined {
    return this.db
      .prepare(
        `SELECT ${columns} FROM messages m WHERE m.id=:id AND ${visible}`,
      )
      .get({ id, actor }) as Message | undefined;
  }
  /**
   * Stores a message for every addressed member of the sender's room, active or away.
   * A reply also acknowledges the sender's delivery of the message it answers.
   */
  send(
    actor: Client,
    input: unknown,
  ): { message: Message; fresh: boolean; acknowledged: number } {
    const data = sendSchema.parse(input);
    if (!this.client(actor.id)) throw new Problem(401, "Client revoked");
    const room = this.requireRoom(actor.id);
    if (data.reply_to && this.message(actor.id, data.reply_to)?.room !== room)
      throw new Problem(404, "Reply message not found");
    const request = JSON.stringify({ ...data, room });
    if (data.idempotency_key) {
      const old = this.db
        .prepare(
          "SELECT id,request_json FROM messages WHERE sender=? AND idempotency_key=?",
        )
        .get(actor.id, data.idempotency_key) as
        { id: number; request_json: string } | undefined;
      if (old) {
        if (old.request_json !== request)
          throw new Problem(
            409,
            "Idempotency key already used with different content",
          );
        return {
          message: this.sentMessage(actor.id, old.id, room),
          fresh: false,
          acknowledged: 0,
        };
      }
    }
    const sender = this.membership(actor.id)!;
    const broadcast = data.to.toLowerCase() === "all";
    const recipient = broadcast
      ? undefined
      : (this.db
          .prepare(
            "SELECT r.client_id AS id,r.name FROM room_memberships r JOIN clients c ON c.id=r.client_id WHERE c.revoked=0 AND r.room=? AND r.name=? COLLATE NOCASE",
          )
          .get(room, data.to) as { id: string; name: string } | undefined);
    if (!broadcast && !recipient)
      throw new Problem(
        404,
        `No participant named "${data.to}" in room "${room}". Call list_clients for the current names.`,
      );
    if (recipient?.id === actor.id)
      throw new Problem(400, "You cannot send a message to yourself");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO messages(sender,sender_name,recipient,recipient_name,room,channel,body,reply_to,idempotency_key,request_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          actor.id,
          sender.name,
          recipient?.id ?? null,
          recipient?.name ?? null,
          room,
          data.channel,
          data.body,
          data.reply_to ?? null,
          data.idempotency_key ?? null,
          request,
        );
      const id = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO deliveries(message_id,client_id)
        SELECT ?,c.id FROM clients c JOIN room_memberships r ON r.client_id=c.id WHERE c.revoked=0 AND c.id<>? AND (? OR c.id=?) AND r.room=?`,
        )
        .run(id, actor.id, Number(broadcast), recipient?.id ?? null, room);
      const acknowledged = data.reply_to
        ? Number(
            this.db
              .prepare(
                `UPDATE deliveries SET acked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE message_id=? AND client_id=? AND acked_at IS NULL`,
              )
              .run(data.reply_to, actor.id).changes,
          )
        : 0;
      this.db.exec("COMMIT");
      return {
        message: this.sentMessage(actor.id, id, room),
        fresh: true,
        acknowledged,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private sentMessage(actor: string, id: number, room: string): Message {
    // Authorization and room presence were checked at the start of the send.
    return this.db
      .prepare(
        `SELECT ${columns} FROM messages m WHERE m.id=? AND m.sender=? AND m.room=?`,
      )
      .get(id, actor, room) as Message;
  }
  /** The latest visible messages of one room, oldest first. */
  transcript(actor: string, room: string, limit = 200): Message[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM messages m WHERE m.room=:room AND ${visible} ORDER BY m.id DESC LIMIT :limit`,
        )
        .all({ room, actor, limit }) as Message[]
    ).reverse();
  }
  /** The latest visible message of every room the actor can see. */
  latest(actor: string): Message[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM messages m WHERE m.id IN (
        SELECT MAX(m.id) FROM messages m WHERE ${visible} GROUP BY m.room
      ) ORDER BY m.id DESC LIMIT 200`,
      )
      .all({ actor }) as Message[];
  }
  since(actor: string, after: number, limit = 101): Message[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM messages m WHERE m.id>:after AND ${visible} ORDER BY m.id LIMIT :limit`,
      )
      .all({ after, actor, limit }) as Message[];
  }
  inbox(actor: string, limit = 4): Message[] {
    return this.db
      .prepare(
        `SELECT ${columns}
      FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE d.client_id=? AND d.acked_at IS NULL AND m.room=? ORDER BY m.id LIMIT ?`,
      )
      .all(actor, this.room(actor) ?? null, limit) as Message[];
  }
  pending(actor: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE client_id=? AND acked_at IS NULL AND m.room=?",
        )
        .get(actor, this.room(actor) ?? null) as { count: number }
    ).count;
  }
  acknowledge(actor: string, ids: number[]): number {
    const room = this.requireRoom(actor);
    this.db.exec("BEGIN");
    try {
      let changed = 0;
      for (const id of ids) {
        if (
          !this.db
            .prepare(
              "SELECT message_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE message_id=? AND client_id=? AND m.room=?",
            )
            .get(id, actor, room)
        ) {
          throw new Problem(404, "Delivery not found");
        }
        const update = this.db
          .prepare(
            `UPDATE deliveries SET acked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE message_id=? AND client_id=? AND acked_at IS NULL`,
          )
          .run(id, actor);
        changed += Number(update.changes);
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
