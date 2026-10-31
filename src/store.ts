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
export type Participant = {
  id: string;
  name: string;
  kind: string;
  client_name: string;
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
  kind: string;
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

const columns =
  "m.id,m.sender,m.sender_name,m.recipient,m.recipient_name,m.room,m.channel,m.body,m.kind,m.reply_to,m.created_at";
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
  ELSE m.room=(SELECT room FROM room_memberships WHERE client_id=:actor AND expires_at>:now)
    AND (m.sender=:actor OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.client_id=:actor))
  END`;

export class Store {
  readonly db: DatabaseSync;
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
    // A relay restart cannot prove that previous participants are still alive.
    this.db.exec("UPDATE room_memberships SET expires_at=0");
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
  room(actor: string, now = Date.now()): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT room FROM room_memberships WHERE client_id=? AND expires_at>?",
        )
        .get(actor, now) as { room: string } | undefined
    )?.room;
  }
  /** The current membership, including one suspended by a disconnect that its client may renew. */
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
  requireRoom(actor: string, now = Date.now()): string {
    const room = this.room(actor, now);
    if (!room)
      throw new Problem(
        409,
        "Join a task room with join_room before messaging or discovering participants",
      );
    return room;
  }
  /** Joining sets the room name; rejoining the same room without a name keeps the current one. */
  joinRoom(actor: string, input: unknown): { room: string; name: string } {
    const data = joinSchema.parse(input);
    const client = this.client(actor);
    if (!client) throw new Problem(401, "Client revoked");
    const current = this.membership(actor);
    const name =
      data.name ?? (current?.room === data.room ? current.name : client.name);
    this.db
      .prepare(
        `INSERT INTO room_memberships(client_id,room,name,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET room=excluded.room,name=excluded.name,expires_at=excluded.expires_at`,
      )
      .run(actor, data.room, name, Date.now() + 60_000);
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
          .run(Date.now() + 60_000, actor, room).changes,
      ) > 0
    );
  }
  suspendRoom(actor: string): void {
    this.db
      .prepare("UPDATE room_memberships SET expires_at=0 WHERE client_id=?")
      .run(actor);
  }
  expireRooms(): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE room_memberships SET expires_at=0 WHERE expires_at>0 AND expires_at<=?",
          )
          .run(Date.now()).changes,
      ) > 0
    );
  }
  /** Active participants of every room, as they named themselves in that room. */
  presence(): (Participant & { room: string })[] {
    return this.db
      .prepare(
        `SELECT r.room,c.id,r.name,c.kind,c.name AS client_name FROM clients c
      JOIN room_memberships r ON r.client_id=c.id WHERE c.revoked=0 AND r.expires_at>?
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
      .get({ id, actor, now: Date.now() }) as Message | undefined;
  }
  send(actor: Client, input: unknown): { message: Message; fresh: boolean } {
    const data = sendSchema.parse(input);
    const now = Date.now();
    if (!this.client(actor.id)) throw new Problem(401, "Client revoked");
    const room = this.requireRoom(actor.id, now);
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
        };
      }
    }
    const sender = this.membership(actor.id)!;
    const recipient = data.to === "all" ? undefined : this.membership(data.to);
    if (
      data.to !== "all" &&
      (!this.client(data.to) || this.room(data.to, now) !== room)
    )
      throw new Problem(
        404,
        "Recipient is not an active participant in this room",
      );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO messages(sender,sender_name,recipient,recipient_name,room,channel,body,kind,reply_to,idempotency_key,request_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          actor.id,
          sender.name,
          data.to === "all" ? null : data.to,
          recipient?.name ?? null,
          room,
          data.channel,
          data.body,
          data.kind,
          data.reply_to ?? null,
          data.idempotency_key ?? null,
          request,
        );
      const id = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO deliveries(message_id,client_id)
        SELECT ?,c.id FROM clients c JOIN room_memberships r ON r.client_id=c.id WHERE c.revoked=0 AND c.id<>? AND (?='all' OR c.id=?) AND r.room=? AND r.expires_at>?`,
        )
        .run(id, actor.id, data.to, data.to, room, now);
      this.db.exec("COMMIT");
      return { message: this.sentMessage(actor.id, id, room), fresh: true };
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
        .all({ room, actor, now: Date.now(), limit }) as Message[]
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
      .all({ actor, now: Date.now() }) as Message[];
  }
  since(actor: string, after: number, limit = 101): Message[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM messages m WHERE m.id>:after AND ${visible} ORDER BY m.id LIMIT :limit`,
      )
      .all({ after, actor, now: Date.now(), limit }) as Message[];
  }
  inbox(actor: string, limit = 8): Message[] {
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
