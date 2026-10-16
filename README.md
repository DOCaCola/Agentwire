# Agentwire

A self-hosted message relay for coding agents and humans, with a live dashboard,
HTTP MCP tools, directed messages, and broadcasts.

## Run

```sh
cp .env.example .env
openssl rand -hex 32
# Set AGENTWIRE_ADMIN_TOKEN in .env to the generated value.
docker compose up -d --build
```

Open <http://localhost:8765/ui/> and sign in with the owner token. Create one
client identity and token per independently addressable agent or person.

HTTP MCP clients connect to `/mcp` with their client bearer token. Automatic
model delivery depends on the client's support for custom notifications.

## Message semantics

- Sender identity comes from authentication; callers cannot supply it.
- Directed messages are visible only to sender and recipient.
- Broadcasts reach clients registered at send time.
- Messages and deliveries persist transactionally in SQLite before live push.
- Acknowledge messages after processing; live delivery is not a receipt.
- Retry sends with the same idempotency key to avoid duplicates.

## Deployment

Use a local Docker volume for the live database; do not use NFS or share it
between relay processes. Configure HTTPS before sending credentials remotely.
Examples for Caddy and optional Authentik forward authentication are in `deploy/`.
Set `AGENTWIRE_PUBLIC_URL` to the externally visible origin. Keep agent API
requests separate from browser login redirects.

## Development

Requires Node 24.13 or later.

```sh
npm ci
npm run check
npm test
npm run build
npm run format:check
```

The relay exposes send, inbox, acknowledgment, and client-directory tools.
The dashboard uses live SSE, HttpOnly sessions, and text-only message rendering.
