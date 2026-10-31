import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clientId, sendSchema, roomName } from "./protocol.js";
export type SendInput = z.input<typeof sendSchema>;
export type Client = {
  id: string;
  name: string;
  kind: string;
  admin: number;
  revoked: number;
  created_at: string;
};
export type Message = {
  id: number;
  sender: string;
  recipient: string | null;
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
  requireRoom(actor: string, now = Date.now()): string {
    const room = this.room(actor, now);
    if (!room)
      throw new Problem(
        409,
        "Join a task room with join_room before messaging or discovering participants",
      );
    return room;
  }
  joinRoom(actor: string, input: unknown): string {
    const room = roomName.parse(input);
    this.db
      .prepare(
        `INSERT INTO room_memberships(client_id,room,expires_at) VALUES (?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET room=excluded.room,expires_at=excluded.expires_at`,
      )
      .run(actor, room, Date.now() + 60_000);
    return room;
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
  participants(actor: string): Client[] {
    const room = this.room(actor);
    if (!room) return [];
    return this.db
      .prepare(
        `SELECT c.id,c.name,c.kind,c.admin,c.revoked,c.created_at FROM clients c
      JOIN room_memberships r ON r.client_id=c.id WHERE c.revoked=0 AND r.room=? AND r.expires_at>? ORDER BY c.name,c.id`,
      )
      .all(room, Date.now()) as Client[];
  }
  rooms(): { room: string; participants: number }[] {
    return this.db
      .prepare(
        `SELECT r.room,COUNT(*) AS participants FROM room_memberships r JOIN clients c ON c.id=r.client_id
      WHERE c.revoked=0 AND r.expires_at>? GROUP BY r.room ORDER BY r.room LIMIT 1000`,
      )
      .all(Date.now()) as { room: string; participants: number }[];
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
  private visible() {
    // Fan-out membership is fixed at send time; new clients cannot read old broadcasts.
    return `m.room=(SELECT room FROM room_memberships WHERE client_id=? AND expires_at>?) AND (m.sender=? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.client_id=?))`;
  }
  message(actor: string, id: number): Message | undefined {
    return this.db
      .prepare(
        `SELECT m.id,m.sender,m.recipient,m.room,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m WHERE m.id=? AND ${this.visible()}`,
      )
      .get(id, actor, Date.now(), actor, actor) as Message | undefined;
  }
  send(actor: Client, input: unknown): { message: Message; fresh: boolean } {
    const data = sendSchema.parse(input);
    const now = Date.now();
    if (!this.client(actor.id)) throw new Problem(401, "Client revoked");
    const room = this.requireRoom(actor.id, now);
    if (data.reply_to && !this.message(actor.id, data.reply_to))
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
          `INSERT INTO messages(sender,recipient,room,channel,body,kind,reply_to,idempotency_key,request_json)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          actor.id,
          data.to === "all" ? null : data.to,
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
        `SELECT id,sender,recipient,room,channel,body,kind,reply_to,created_at FROM messages
      WHERE id=? AND sender=? AND room=?`,
      )
      .get(id, actor, room) as Message;
  }
  history(actor: string, after = 0, limit = 100): Message[] {
    return (
      this.db
        .prepare(
          `SELECT m.id,m.sender,m.recipient,m.room,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m WHERE m.id>? AND ${this.visible()} ORDER BY m.id DESC LIMIT ?`,
        )
        .all(after, actor, Date.now(), actor, actor, limit) as Message[]
    ).reverse();
  }
  since(actor: string, after: number, limit = 101): Message[] {
    return this.db
      .prepare(
        `SELECT m.id,m.sender,m.recipient,m.room,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m WHERE m.id>? AND ${this.visible()} ORDER BY m.id LIMIT ?`,
      )
      .all(after, actor, Date.now(), actor, actor, limit) as Message[];
  }
  inbox(actor: string, limit = 8): Message[] {
    return this.db
      .prepare(
        `SELECT m.id,m.sender,m.recipient,m.room,m.channel,m.body,m.kind,m.reply_to,m.created_at
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
