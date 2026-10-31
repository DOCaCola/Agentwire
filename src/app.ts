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
import { McpEndpoint } from "./mcp.js";
import { ackSchema, inboxSchema } from "./protocol.js";
import { eventStream } from "./sse.js";
import { relayUrl } from "./url.js";
import { IdentityStore } from "./identity.js";
import { configureOidc, type OidcOptions } from "./oidc.js";

export type Options = {
  database: string;
  adminToken: string;
  publicUrl: string;
  oidc?: OidcOptions;
};
export function createAgentwire(options: Options) {
  if (options.adminToken.length < 32)
    throw new Error(
      "AGENTWIRE_ADMIN_TOKEN must contain at least 32 characters",
    );
  const publicUrl = relayUrl(options.publicUrl);
  const basePath = publicUrl.pathname.slice(0, -1);
  const store = new Store(options.database, options.adminToken);
  const identities = new IdentityStore(store);
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
    path: publicUrl.pathname,
  };
  const cookieName = cookieOptions.secure
    ? basePath
      ? "__Secure-agentwire"
      : "__Host-agentwire"
    : "agentwire";
  const login = (client: Client, res: Response) => {
    if (sessions.size >= 1000)
      throw new Problem(429, "Browser session limit reached");
    const key = randomBytes(32).toString("base64url");
    sessions.set(hashToken(key), {
      client: client.id,
      expires: Date.now() + 12 * 60 * 60_000,
    });
    res.cookie(cookieName, key, { ...cookieOptions, maxAge: 12 * 60 * 60_000 });
  };
  const oidc = options.oidc
    ? configureOidc(app, options.oidc, publicUrl, identities, login, () =>
        hub.publish({ type: "clients" }),
      )
    : undefined;
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
  const human = (_req: Request, res: Response, next: NextFunction) => {
    if (actor(res).kind !== "human")
      throw new Problem(403, "Human access required");
    next();
  };
  const enrollmentStreams = new Map<string, Set<() => void>>();
  const deviceChanged = (id: string) => {
    for (const send of enrollmentStreams.get(id) ?? []) send();
    hub.publish({ type: "devices" });
  };
  const reap = setInterval(() => {
    for (const [key, value] of sessions)
      if (value.expires < Date.now()) sessions.delete(key);
    for (const id of identities.expire()) deviceChanged(id);
  }, 60_000).unref();
  app.get("/healthz", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.get("/api/auth", (_req, res) => {
    res.json({
      oidc: Boolean(options.oidc),
      label: options.oidc?.label ?? "OpenID Connect",
    });
  });
  app.post("/api/enrollment", (req, res) => {
    identities.expire();
    const device = identities.enroll(req.body);
    deviceChanged(device.id);
    res.status(201).json({
      ...device,
      verification_url: new URL("ui/#devices", publicUrl).href,
    });
  });
  const deviceCredential = (req: Request) => {
    const token = req.get("authorization");
    const device = token?.startsWith("Bearer ")
      ? identities.credential(token.slice(7))
      : undefined;
    if (!device) throw new Problem(401, "Device credential required");
    return device;
  };
  app.get("/api/enrollment/events", (req, res) => {
    identities.expire();
    const device = deviceCredential(req);
    let watchers = enrollmentStreams.get(device.id);
    if (!watchers) {
      watchers = new Set();
      enrollmentStreams.set(device.id, watchers);
    }
    if (watchers.size >= 4)
      throw new Problem(429, "Too many enrollment connections");
    const { send } = eventStream(res);
    const update = () => {
      const current = identities.device(device.id)!;
      send("enrollment", { status: current.status });
      if (current.status !== "pending") res.end();
    };
    watchers.add(update);
    res.on("close", () => {
      watchers.delete(update);
      if (!watchers.size) enrollmentStreams.delete(device.id);
    });
    update();
  });
  app.post("/api/device/clients", (req, res) => {
    const client = identities.session(deviceCredential(req), req.body);
    hub.publish({ type: "clients" });
    res.status(201).json({ client });
  });
  app.post("/api/login", (req, res) => {
    const { token } = z
      .object({ token: z.string().min(32).max(256) })
      .strict()
      .parse(req.body);
    const client = store.authenticate(token);
    if (!client) throw new Problem(401, "Invalid token");
    login(client, res);
    res.json({ client });
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
  const clients = (viewer: Client) =>
    store.clients().map((client) => ({
      ...client,
      connections: hub.online(client.id),
      can_manage:
        viewer.kind === "human" && identities.owned(viewer, client.id),
      can_rotate: Boolean(
        viewer.admin &&
        !identities.isOidc(client.id) &&
        !identities.isDeviceClient(client.id),
      ),
    }));
  app.get("/api/state", (_req, res) => {
    const client = actor(res);
    res.json({
      client,
      clients: clients(client),
      messages: store.history(client.id),
      inbox: store.inbox(client.id, 100),
      pending: store.pending(client.id),
      devices: client.kind === "human" ? identities.devices(client) : [],
    });
  });
  app.get("/api/clients", (_req, res) => {
    res.json(clients(actor(res)));
  });
  app.get("/api/inbox", (req, res) => {
    const { limit } = inboxSchema.parse(
      req.query.limit === undefined ? {} : { limit: Number(req.query.limit) },
    );
    const client = actor(res);
    res.json({
      messages: store.inbox(client.id, limit),
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
  app.get("/api/devices", human, (_req, res) =>
    res.json(identities.devices(actor(res))),
  );
  app.post("/api/devices/:id", human, async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const device = identities.decide(actor(res), id, req.body);
    if (device.status === "revoked") {
      const children = identities.children(id);
      for (const child of children)
        if (store.client(child)) store.revoke(child);
      await Promise.all(children.map(disconnect));
    }
    deviceChanged(id);
    res.json(device);
  });
  app.post("/api/clients/:id/rotate", admin, async (req, res) => {
    const id = z.string().parse(req.params.id);
    if (identities.isOidc(id))
      throw new Problem(400, "OpenID accounts do not use client tokens");
    if (identities.isDeviceClient(id))
      throw new Problem(
        400,
        "Device agent credentials are managed on the device; revoke this agent or its device instead",
      );
    const token = store.rotate(id);
    await disconnect(id);
    res.json({ token });
  });
  app.delete("/api/clients/:id", human, async (req, res) => {
    const id = z.string().parse(req.params.id);
    if (!identities.owned(actor(res), id))
      throw new Problem(403, "Client is not yours");
    store.revoke(id);
    const disconnected = [id];
    // Revoking a human account also invalidates all devices they approved.
    for (const device of identities
      .devices({ ...actor(res), admin: 1 })
      .filter((item) => item.owner_id === id && item.status === "approved")) {
      identities.decide({ ...actor(res), admin: 1 }, device.id, {
        action: "revoke",
      });
      for (const child of identities.children(device.id)) {
        if (store.client(child)) store.revoke(child);
        disconnected.push(child);
      }
      deviceChanged(device.id);
    }
    await Promise.all(disconnected.map(disconnect));
    res.json({ ok: true });
  });
  app.post("/api/messages", (req, res) => {
    const result = store.send(actor(res), req.body);
    if (result.fresh) hub.publish({ type: "message", message: result.message });
    res.status(result.fresh ? 201 : 200).json(result.message);
  });
  app.post("/api/ack", (req, res) => {
    const { ids } = ackSchema.parse(req.body);
    const acknowledged = store.acknowledge(actor(res).id, ids);
    hub.publish({ type: "inbox", acknowledged }, actor(res).id);
    res.json({ ok: true });
  });
  app.get("/api/channel-events", (_req, res) => {
    const client = actor(res);
    if (hub.online(client.id) >= 16)
      throw new Problem(429, "Connection limit reached");
    const { send } = eventStream(res);
    send("inbox", { pending: store.pending(client.id), acknowledged: 0 });
    const unsubscribe = hub.subscribe({
      client: client.id,
      close: () => res.end(),
      send: (event) => {
        if (
          event.type === "inbox" ||
          (event.type === "message" && event.message.sender !== client.id)
        ) {
          send("inbox", {
            pending: store.pending(client.id),
            acknowledged: event.type === "inbox" ? event.acknowledged : 0,
          });
        }
      },
    });
    res.on("close", unsubscribe);
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
    const { send } = eventStream(res);
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
            send("clients", clients(store.client(client.id)!));
            break;
          case "devices":
            if (client.kind === "human")
              send("devices", identities.devices(store.client(client.id)!));
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
    res.on("close", unsubscribe);
  });
  app.all("/mcp", authenticate(true), async (req, res) => {
    await mcp.handle(req, res, actor(res));
  });
  app.get("/", (_req, res) => {
    res.redirect(`${basePath}/ui/`);
  });
  app.get("/ui", (_req, res) => {
    res.redirect(`${basePath}/ui/`);
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
  const mounted = express();
  mounted.disable("x-powered-by");
  mounted.use(basePath || "/", app);
  return {
    app: mounted,
    store,
    identities,
    hub,
    async close() {
      clearInterval(reap);
      oidc?.close();
      for (const watchers of enrollmentStreams.values()) watchers.clear();
      hub.close();
      await mcp.close();
      store.close();
    },
  };
}
