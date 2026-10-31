import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import * as oidc from "openid-client";
import { fixture, ownerToken } from "./support.js";

test("OpenID login validates PKCE, browser state, nonce, issuer, audience, signatures and groups, then maps a stable human identity", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  let issuer = "",
    username = "Alice",
    groups = ["Agentwire Users", "Agentwire Admins"];
  let corrupt: "" | "nonce" | "audience" | "issuer" | "signature" = "";
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string }
  >();
  const as = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    } else if (url.pathname === "/jwks")
      res.end(JSON.stringify({ keys: [jwk] }));
    else if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("scope"), "openid profile email");
      const code = randomUUID();
      const redirect = url.searchParams.get("redirect_uri")!;
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        redirect,
      });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: callback.href }).end();
    } else if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const flow = codes.get(params.get("code")!);
      codes.delete(params.get("code")!);
      if (
        !flow ||
        createHash("sha256")
          .update(params.get("code_verifier")!)
          .digest("base64url") !== flow.challenge ||
        params.get("redirect_uri") !== flow.redirect ||
        decodeURIComponent(
          Buffer.from(req.headers.authorization!.slice(6), "base64").toString(),
        ) !== "agentwire:test-secret"
      ) {
        res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: corrupt === "issuer" ? issuer + "/other" : issuer,
        sub: "stable-alice-subject",
        aud: corrupt === "audience" ? "another-app" : "agentwire",
        iat: now,
        exp: now + 600,
        nonce: corrupt === "nonce" ? "wrong" : flow.nonce,
        preferred_username: username,
        groups,
      };
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const input =
        encode({ alg: "RS256", kid: "test-key", typ: "JWT" }) +
        "." +
        encode(claims);
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(input),
        privateKey,
      ).toString("base64url");
      res.end(
        JSON.stringify({
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 600,
          id_token:
            input +
            "." +
            (corrupt === "signature"
              ? "A".repeat(signature.length)
              : signature),
        }),
      );
    } else res.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(as, "listening");
  issuer = `http://127.0.0.1:${(as.address() as { port: number }).port}`;
  const f = await fixture(undefined, "/relay", {
    issuer,
    clientId: "agentwire",
    clientSecret: "test-secret",
    allowedGroup: "Agentwire Users",
    adminGroup: "Agentwire Admins",
    configuration: () =>
      oidc.discovery(
        new URL(issuer),
        "agentwire",
        "test-secret",
        oidc.ClientSecretBasic("test-secret"),
        { execute: [oidc.allowInsecureRequests] },
      ),
  });
  async function start() {
    const login = await fetch(f.url + "/auth/login", { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(login.headers.get("set-cookie")!, /SameSite=Lax/);
    const authorization = await fetch(login.headers.get("location")!, {
      redirect: "manual",
    });
    return {
      url: authorization.headers.get("location")!,
      cookie: login.headers.get("set-cookie")!.split(";")[0]!,
    };
  }
  async function finish(flow: Awaited<ReturnType<typeof start>>) {
    return fetch(flow.url, {
      redirect: "manual",
      headers: { Cookie: flow.cookie },
    });
  }
  try {
    assert.deepEqual(await (await fetch(f.url + "/api/auth")).json(), {
      oidc: true,
      label: "OpenID Connect",
    });
    const flow = await start();
    assert.equal((await fetch(flow.url, { redirect: "manual" })).status, 400);
    const signedIn = await finish(flow);
    assert.equal(signedIn.status, 302);
    assert.equal(signedIn.headers.get("location"), "/relay/ui/");
    const cookie = signedIn.headers
      .getSetCookie()
      .find((value) => value.startsWith("agentwire="))!
      .split(";")[0]!;
    assert.ok(!cookie.includes("test-access-token"));
    const state = await (
      await fetch(f.url + "/api/state", { headers: { Cookie: cookie } })
    ).json();
    assert.equal(state.client.kind, "human");
    assert.equal(state.client.admin, 1);
    assert.equal(state.client.name, "Alice");
    assert.notEqual(state.client.id, "owner");
    assert.equal((await finish(flow)).status, 400, "callback is single use");
    const mismatch = await start();
    mismatch.url = mismatch.url.replace(/state=[^&]+/, "state=wrong");
    assert.equal((await finish(mismatch)).status, 400);
    for (const mode of ["nonce", "issuer", "audience", "signature"] as const) {
      corrupt = mode;
      assert.equal((await finish(await start())).status, 400, mode);
    }
    corrupt = "";
    groups = ["Not Agentwire"];
    assert.equal((await finish(await start())).status, 403);
    groups = ["Agentwire Users"];
    username = "Alice renamed";
    const renamed = await finish(await start());
    assert.equal(renamed.status, 302);
    const renamedCookie = renamed.headers
      .getSetCookie()
      .find((value) => value.startsWith("agentwire="))!
      .split(";")[0]!;
    const updated = await (
      await fetch(f.url + "/api/state", { headers: { Cookie: renamedCookie } })
    ).json();
    assert.equal(updated.client.id, state.client.id);
    assert.equal(updated.client.admin, 0);
    assert.equal(updated.client.name, "Alice renamed");
    assert.equal(
      (await fetch(f.url + "/mcp", { headers: { Cookie: renamedCookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request(
          `/api/clients/${state.client.id}/rotate`,
          ownerToken,
          {},
        )
      ).status,
      400,
    );
    await f.request(
      `/api/clients/${state.client.id}`,
      ownerToken,
      undefined,
      "DELETE",
    );
    assert.equal(
      (await finish(await start())).status,
      403,
      "IdP login must not resurrect a locally revoked account",
    );
  } finally {
    await f.stop();
    as.closeAllConnections();
    await new Promise<void>((resolve) => as.close(() => resolve()));
  }
});
