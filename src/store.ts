import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clientId, sendSchema } from "./protocol.js";
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
      PRAGMA user_version=1;
    `);
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
    if (this.clients().length >= 100)
      throw new Problem(409, "Client limit reached (100)");
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
    this.db
      .prepare("UPDATE clients SET revoked=1,token_hash=NULL WHERE id=?")
      .run(id);
  }
  private visible() {
    // Fan-out membership is fixed at send time; new clients cannot read old broadcasts.
    return `(m.sender=? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.client_id=?))`;
  }
  message(actor: string, id: number): Message | undefined {
    return this.db
      .prepare(
        `SELECT m.id,m.sender,m.recipient,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m WHERE m.id=? AND ${this.visible()}`,
      )
      .get(id, actor, actor) as Message | undefined;
  }
  send(actor: Client, input: unknown): { message: Message; fresh: boolean } {
    const data = sendSchema.parse(input);
    if (!this.client(actor.id)) throw new Problem(401, "Client revoked");
    if (data.to !== "all" && !this.client(data.to))
      throw new Problem(404, "Recipient not found");
    if (data.reply_to && !this.message(actor.id, data.reply_to))
      throw new Problem(404, "Reply message not found");
    const request = JSON.stringify(data);
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
        return { message: this.message(actor.id, old.id)!, fresh: false };
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO messages(sender,recipient,channel,body,kind,reply_to,idempotency_key,request_json)
        VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          actor.id,
          data.to === "all" ? null : data.to,
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
        SELECT ?,id FROM clients WHERE revoked=0 AND id<>? AND (?='all' OR id=?)`,
        )
        .run(id, actor.id, data.to, data.to);
      this.db.exec("COMMIT");
      return { message: this.message(actor.id, id)!, fresh: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(actor: string, after = 0, limit = 100): Message[] {
    return (
      this.db
        .prepare(
          `SELECT m.id,m.sender,m.recipient,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m WHERE m.id>? AND ${this.visible()} ORDER BY m.id DESC LIMIT ?`,
        )
        .all(after, actor, actor, limit) as Message[]
    ).reverse();
  }
  since(actor: string, after: number, limit = 101): Message[] {
    return this.db
      .prepare(
        `SELECT m.id,m.sender,m.recipient,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m WHERE m.id>? AND ${this.visible()} ORDER BY m.id LIMIT ?`,
      )
      .all(after, actor, actor, limit) as Message[];
  }
  inbox(actor: string, limit = 8): Message[] {
    return this.db
      .prepare(
        `SELECT m.id,m.sender,m.recipient,m.channel,m.body,m.kind,m.reply_to,m.created_at
      FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE d.client_id=? AND d.acked_at IS NULL ORDER BY m.id LIMIT ?`,
      )
      .all(actor, limit) as Message[];
  }
  pending(actor: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM deliveries WHERE client_id=? AND acked_at IS NULL",
        )
        .get(actor) as { count: number }
    ).count;
  }
  acknowledge(actor: string, ids: number[]): number {
    this.db.exec("BEGIN");
    try {
      let changed = 0;
      for (const id of ids) {
        if (
          !this.db
            .prepare(
              "SELECT message_id FROM deliveries WHERE message_id=? AND client_id=?",
            )
            .get(id, actor)
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
