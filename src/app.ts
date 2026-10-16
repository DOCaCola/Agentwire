import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import type {
  ErrorRequestHandler,
  Request,
  Response,
  NextFunction,
} from "express";
import { z } from "zod";
import { Store, Problem, hashToken, type Client } from "./store.js";
import { Hub } from "./hub.js";
import { McpEndpoint, ackSchema } from "./mcp.js";

export type Options = {
  database: string;
  adminToken: string;
  publicUrl: string;
};
export function createAgentwire(options: Options) {
  if (options.adminToken.length < 32)
    throw new Error(
      "AGENTWIRE_ADMIN_TOKEN must contain at least 32 characters",
    );
  const publicUrl = new URL(options.publicUrl);
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      "AGENTWIRE_PUBLIC_URL must be an HTTP(S) origin, without a path",
    );
  }
  const store = new Store(options.database, options.adminToken);
  const hub = new Hub(store);
  const mcp = new McpEndpoint(store, hub);
  const sessions = new Map<string, { client: string; expires: number }>();
  const app = express();
  app.disable("x-powered-by");
  app.enable("strict routing");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Cache-Control": "no-store",
    });
    if (req.get("host") !== publicUrl.host) {
      res.status(421).json({ error: "Unexpected Host header" });
      return;
    }
    if (req.get("origin") && req.get("origin") !== publicUrl.origin) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: publicUrl.protocol === "https:",
    path: "/",
  };
  const cookieName = cookieOptions.secure ? "__Host-agentwire" : "agentwire";
  const actor = (res: Response) => res.locals.client as Client;
  const authenticate =
    (bearerOnly: boolean) =>
    (req: Request, res: Response, next: NextFunction) => {
      const header = req.get("authorization");
      let client: Client | undefined;
      if (header?.startsWith("Bearer "))
        client = store.authenticate(header.slice(7));
      else if (!bearerOnly) {
        const cookie = req.headers.cookie
          ?.split(";")
          .map((value) => value.trim())
          .find((value) => value.startsWith(`${cookieName}=`));
        const key = cookie?.slice(cookieName.length + 1);
        const session = key ? sessions.get(hashToken(key)) : undefined;
        if (session && session.expires > Date.now()) {
          client = store.client(session.client);
          res.locals.sessionExpires = session.expires;
        }
      }
      if (!client) {
        res
          .set("WWW-Authenticate", "Bearer")
          .status(401)
          .json({ error: "Authentication required" });
        return;
      }
      res.locals.client = client;
      next();
    };
  const admin = (_req: Request, res: Response, next: NextFunction) => {
    if (!actor(res).admin) {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    next();
  };
  const reap = setInterval(() => {
    for (const [key, value] of sessions)
      if (value.expires < Date.now()) sessions.delete(key);
  }, 60_000).unref();
  app.get("/healthz", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.post("/api/login", (req, res) => {
    const { token } = z
      .object({ token: z.string().min(32).max(256) })
      .strict()
      .parse(req.body);
    const client = store.authenticate(token);
    if (!client) throw new Problem(401, "Invalid token");
    // Keep browser sessions bounded even if a credential is repeatedly submitted.
    if (sessions.size >= 1000)
      throw new Problem(429, "Browser session limit reached");
    const key = randomBytes(32).toString("base64url");
    sessions.set(hashToken(key), {
      client: client.id,
      expires: Date.now() + 12 * 60 * 60_000,
    });
    res
      .cookie(cookieName, key, { ...cookieOptions, maxAge: 12 * 60 * 60_000 })
      .json({ client });
  });
  app.use("/api", authenticate(false));
  app.post("/api/logout", (req, res) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${cookieName}=`));
    if (cookie) sessions.delete(hashToken(cookie.slice(cookieName.length + 1)));
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  const clients = () =>
    store
      .clients()
      .map((client) => ({ ...client, connections: hub.online(client.id) }));
  app.get("/api/state", (_req, res) => {
    const client = actor(res);
    res.json({
      client,
      clients: clients(),
      messages: store.history(client.id),
      inbox: store.inbox(client.id, 100),
      pending: store.pending(client.id),
    });
  });
  app.post("/api/clients", admin, (req, res) => {
    const result = store.createClient(req.body);
    hub.publish({ type: "clients" });
    res.status(201).json(result);
  });
  const disconnect = async (id: string) => {
    for (const [key, value] of sessions)
      if (value.client === id) sessions.delete(key);
    hub.disconnect(id);
    await mcp.disconnect(id);
  };
  app.post("/api/clients/:id/rotate", admin, async (req, res) => {
    const id = z.string().parse(req.params.id);
    const token = store.rotate(id);
    await disconnect(id);
    res.json({ token });
  });
  app.delete("/api/clients/:id", admin, async (req, res) => {
    const id = z.string().parse(req.params.id);
    store.revoke(id);
    await disconnect(id);
    res.json({ ok: true });
  });
  app.post("/api/messages", (req, res) => {
    const result = store.send(actor(res), req.body);
    if (result.fresh) hub.publish({ type: "message", message: result.message });
    res.status(result.fresh ? 201 : 200).json(result.message);
  });
  app.post("/api/ack", (req, res) => {
    const { ids } = ackSchema.parse(req.body);
    store.acknowledge(actor(res).id, ids);
    hub.publish({ type: "inbox" }, actor(res).id);
    res.json({ ok: true });
  });
  app.get("/api/events", (req, res) => {
    const client = actor(res);
    if (hub.online(client.id) >= 16)
      throw new Problem(429, "Connection limit reached");
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(req.get("last-event-id") ?? req.query.after ?? 0);
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (type: string, data: unknown, id?: number) => {
      // A full write buffer ends this connection. Replay/live callbacks must stop
      // writing until the client reconnects with the last accepted event ID.
      if (res.writableEnded) return;
      const ok = res.write(
        `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
      );
      if (!ok) res.end(); // Slow consumers reconnect and recover from SQLite, rather than grow memory.
    };
    const missed = store.since(client.id, after);
    if (missed.length > 100) send("resync", {});
    else for (const message of missed) send("message", message, message.id);
    const unsubscribe = hub.subscribe({
      client: client.id,
      close: () => res.end(),
      send: (event) => {
        switch (event.type) {
          case "message":
            send("message", event.message, event.message.id);
            break;
          case "clients":
            send("clients", clients());
            break;
          case "inbox":
            send("inbox", {
              pending: store.pending(client.id),
              inbox: store.inbox(client.id, 100),
            });
            break;
          case "resync":
            send("resync", {});
            break;
        }
      },
    });
    const heartbeat = setInterval(
      () => res.write(": keepalive\n\n"),
      20_000,
    ).unref();
    // Cookie expiration closes live streams too; bearer streams are bounded to the same duration.
    const expiry = setTimeout(
      () => res.end(),
      res.locals.sessionExpires
        ? res.locals.sessionExpires - Date.now()
        : 12 * 60 * 60_000,
    ).unref();
    res.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      unsubscribe();
    });
  });
  app.all("/mcp", authenticate(true), async (req, res) => {
    await mcp.handle(req, res, actor(res));
  });
  app.get("/", (_req, res) => {
    res.redirect("/ui/");
  });
  app.get("/ui", (_req, res) => {
    res.redirect("/ui/");
  });
  app.use(
    "/ui",
    express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
      index: "index.html",
    }),
  );
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof z.ZodError)
      res.status(400).json({ error: "Invalid input", details: error.issues });
    else if (error instanceof Problem)
      res.status(error.status).json({ error: error.message });
    else if (error instanceof SyntaxError)
      res.status(400).json({ error: "Invalid JSON" });
    else if (error?.type === "entity.too.large")
      res.status(413).json({ error: "Request too large" });
    else {
      console.error("Agentwire request failed:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
  app.use(errors);
  return {
    app,
    store,
    hub,
    async close() {
      clearInterval(reap);
      hub.close();
      await mcp.close();
      store.close();
    },
  };
}
