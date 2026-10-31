import { createHash } from "node:crypto";
import type { Express } from "express";
import * as oidc from "openid-client";
import { z } from "zod";
import { Problem, type Client } from "./store.js";
import type { IdentityStore } from "./identity.js";

export type OidcOptions = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  adminGroup?: string;
  allowedGroup?: string;
  label?: string;
  /** Explicit configuration injection for embedded deployments and protocol tests. */
  configuration?: () => Promise<oidc.Configuration>;
};
type Flow = {
  verifier: string;
  state: string;
  nonce: string;
  expires: number;
  devices: boolean;
};

export function configureOidc(
  app: Express,
  options: OidcOptions,
  base: URL,
  identities: IdentityStore,
  login: (client: Client, res: import("express").Response) => void,
  changed: () => void,
) {
  if (!options.clientId || !options.clientSecret)
    throw new Error("OIDC requires a client ID and secret");
  const issuer = new URL(options.issuer);
  if (issuer.protocol !== "https:" && !options.configuration)
    throw new Error("OIDC issuer requires HTTPS");
  if (base.protocol !== "https:" && !options.configuration)
    throw new Error("OIDC browser login requires HTTPS");
  const callback = new URL("auth/callback", base).href;
  const flows = new Map<string, Flow>();
  const cookieName =
    base.protocol === "https:" ? "__Secure-agentwire-oidc" : "agentwire-oidc";
  const cookieOptions = {
    httpOnly: true,
    secure: base.protocol === "https:",
    sameSite: "lax" as const,
    path: base.pathname,
  };
  let configuration: Promise<oidc.Configuration> | undefined;
  function config() {
    if (!configuration)
      configuration = (
        options.configuration
          ? options.configuration()
          : oidc.discovery(
              issuer,
              options.clientId,
              options.clientSecret,
              oidc.ClientSecretBasic(options.clientSecret),
            )
      )
        .then((value) => {
          oidc.enableNonRepudiationChecks(value);
          return value;
        })
        .catch((error) => {
          configuration = undefined;
          throw error;
        });
    return configuration;
  }
  const reap = setInterval(() => {
    for (const [key, flow] of flows)
      if (flow.expires <= Date.now()) flows.delete(key);
  }, 60_000).unref();
  app.get("/auth/login", async (req, res) => {
    if (flows.size >= 1000) throw new Problem(429, "Too many sign-in attempts");
    let configuration: oidc.Configuration;
    try {
      configuration = await config();
    } catch {
      throw new Problem(
        503,
        "OpenID provider is unavailable; try sign-in again later",
      );
    }
    const verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    const key = oidc.randomState();
    flows.set(createHash("sha256").update(key).digest("hex"), {
      verifier,
      state,
      nonce,
      expires: Date.now() + 10 * 60_000,
      devices: req.query.devices === "1",
    });
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: callback,
      scope: "openid profile email",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    res
      .cookie(cookieName, key, { ...cookieOptions, maxAge: 10 * 60_000 })
      .redirect(url.href);
  });
  app.get("/auth/callback", async (req, res) => {
    const key = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    const hash = key ? createHash("sha256").update(key).digest("hex") : "";
    const flow = flows.get(hash);
    flows.delete(hash);
    res.clearCookie(cookieName, cookieOptions);
    if (!flow || flow.expires <= Date.now())
      throw new Problem(
        400,
        "Sign-in expired or browser binding missing; start sign-in again",
      );
    try {
      const tokens = await oidc.authorizationCodeGrant(
        await config(),
        new URL(req.originalUrl, base.origin),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        },
      );
      const claims = z
        .object({
          iss: z.literal(options.issuer),
          sub: z.string().min(1).max(255),
          name: z.string().optional(),
          preferred_username: z.string().optional(),
          groups: z.array(z.string()).default([]),
        })
        .passthrough()
        .parse(tokens.claims());
      if (options.allowedGroup && !claims.groups.includes(options.allowedGroup))
        throw new Problem(403, "Your account is not allowed to use Agentwire");
      const client = identities.human(
        claims.iss,
        claims.sub,
        claims.preferred_username || claims.name || "Person",
        Boolean(
          options.adminGroup && claims.groups.includes(options.adminGroup),
        ),
      );
      login(client, res);
      changed();
      res.redirect(
        new URL("ui/", base).pathname + (flow.devices ? "#devices" : ""),
      );
    } catch (error) {
      if (error instanceof Problem) throw error;
      // IdP responses and tokens must not appear in application error logs.
      throw new Problem(
        400,
        "OpenID sign-in could not be verified; start sign-in again",
      );
    }
  });
  return {
    close() {
      clearInterval(reap);
      flows.clear();
    },
  };
}
