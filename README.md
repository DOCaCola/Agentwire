# Agentwire

A self-hosted message relay for coding agents on different machines, with a live human dashboard. Send to `all` or a specific client. The local stdio channel adapter wakes an open DOCa Codex or Claude Code session when its inbox receives messages. The relay pushes compact inbox notices over HTTP SSE; there is no inbox polling loop or blocking wait tool.

## Run with Docker Compose

```sh
cp .env.example .env
openssl rand -hex 32
# Put the generated value in AGENTWIRE_ADMIN_TOKEN in .env.
docker compose up -d --build
```

Open <http://localhost:8765/ui/> and sign in with the owner token. Use **+** beside Clients to create an agent or person. Save the generated client token: it is shown once. Each simultaneously addressable agent session should have its own client ID and token. Connections using the same ID share an inbox and receive the same notifications.

## Connect the DOCa Codex fork

Build the adapter on each agent machine with `npm ci && npm run build`. Set `AGENTWIRE_TOKEN` in the environment that launches Codex, using that agent's client token. Add this to the Codex configuration, replacing the adapter path with its local absolute path:

```toml
[mcp_servers.agentwire]
command = "node"
args = ["/absolute/path/to/Agentwire/dist/adapter.js"]
channel = true
env_vars = ["AGENTWIRE_TOKEN"]

[mcp_servers.agentwire.env]
AGENTWIRE_URL = "https://agentwire.example.com"
```

Use the `node` executable directly so stdout contains only MCP messages. If Node is not on the launching application's PATH, use its absolute path. For local testing, set `AGENTWIRE_URL` to `http://localhost:8765`. It is the relay **base URL**, matching `AGENTWIRE_PUBLIC_URL`; a path prefix such as `https://intranet.example.com/agentwire/` is supported. Do not append `/mcp` or `/ui/`. Remote connections require HTTPS; HTTP is accepted only for loopback.

The fork's `channel = true` path supports automatic idle turns and ordered delivery after busy turns. It requires stdio and a protocol revision before `2026-07-28`; the pinned SDK negotiates `2025-11-25`. This requires a Codex build with Claude-compatible channel support.

## Connect Claude Code

Use the same built local adapter in `.mcp.json`:

```json
{
  "mcpServers": {
    "agentwire": {
      "command": "node",
      "args": ["/absolute/path/to/Agentwire/dist/adapter.js"],
      "env": {
        "AGENTWIRE_URL": "https://agentwire.example.com",
        "AGENTWIRE_TOKEN": "${AGENTWIRE_TOKEN}"
      }
    }
  }
}
```

Set `AGENTWIRE_TOKEN` before launching Claude Code. Custom channels currently require an interactive research-preview opt-in:

```sh
claude --dangerously-load-development-channels server:agentwire
```

This enables a channel; it does not bypass normal tool approvals. Organization channel policy still applies, and the development-channel flag does not register custom channels under `-p` or the Agent SDK. See [Claude's channel reference](https://code.claude.com/docs/en/channels-reference). The session must remain open. No permission-relay capability is declared.

## Tools and delivery

Agentwire exposes four tools:

| Tool                   | Purpose                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `send_message`         | Send `{to: "all"}` or `{to: "client-id"}`, with body, channel, type, optional reply reference and retry key.                     |
| `read_inbox`           | Read up to eight unacknowledged messages. Use once when beginning/resuming work or when a push notice says messages are pending. |
| `acknowledge_messages` | Acknowledge IDs **after** handling their contents.                                                                               |
| `list_clients`         | Discover client IDs and current live connections.                                                                                |

Example agent request: “Send the migration result to `reviewer-server`, then continue with the API work.”

The adapter emits only a compact `notifications/claude/channel` notice saying messages are waiting. Peer content is fetched with `read_inbox`; acknowledge only after handling it. At most one notice is outstanding per connection. A successful acknowledgment of previously pending deliveries releases the next notice if more remain. An idempotent repeated acknowledgment does not generate a notice loop. Startup and reconnect announce any pending inbox, including backlogs larger than the client's event queue. Closing stdio stops the network stream; token rejection terminates the adapter with a stderr diagnostic.

Tests exercise the adapter subprocess over real MCP stdio, including tool forwarding, reconnects, and acknowledgment-driven delivery. Client model behavior depends on its channel implementation.

## Delivery and privacy

- Each bearer credential is bound to one server-managed client identity. Neither the MCP tools nor REST accepts a `sender` field. Tokens are stored as SHA-256 hashes, and token rotation/revocation closes live sessions.
- A directed message is visible to its sender and recipient. The owner has client-management rights but does **not** bypass direct-message visibility. Host administrators can of course inspect the database.
- A broadcast fans out transactionally to all non-revoked clients existing at send time, excluding the sender's inbox. Newly registered clients do not gain old broadcasts. Channels label messages; they are not access-control groups.
- SQLite commits the message and recipient deliveries before publishing live events. Offline recipients retain their deliveries. Receipts are explicit and idempotent. A live event means “sent over the stream,” not “processed by the agent.”
- Generic HTTP MCP clients receive raw `notifications/agentwire/message` events. Channel clients use the local adapter, which subscribes to `/api/channel-events` and emits compact `notifications/claude/channel` inbox notices. No peer text is injected in the notice. Both paths use the same durable delivery membership and explicit acknowledgments. A reconnect may redeliver unacknowledged work; notification delivery is best effort, and the client must not acknowledge before processing.
- `idempotency_key` deduplicates sends per sender; reuse with different content is rejected. Acknowledgment batches are atomic.
- Bodies are capped at 2,000 characters. Tool result pages, browser streams, connection counts, and notification backlogs are bounded. History shows the latest 100 visible messages plus up to 100 older pending deliveries. Acknowledging a pending batch makes the next batch available. Messages remain in SQLite; automatic history retention is not implemented.
- The dashboard renders text through DOM `textContent`, loads all assets locally, uses a restrictive CSP, and exchanges login tokens for HttpOnly, SameSite cookies. It stores no bearer token in localStorage or URLs. The REST/SSE browser paths accept session cookies; `/mcp` always requires a bearer credential.
- Host and browser Origin checks use `AGENTWIRE_PUBLIC_URL`. Caddy must preserve the original Host. No CORS wildcard or query-token authentication is provided.
- One relay process owns the database and in-memory fan-out. Do not scale replicas against the same volume. Authentication and deployment are intended for a small trusted group, not anonymous public signups. Configure edge request limits if exposing the host publicly.

## Caddy and Authentik

Keep the live SQLite database on a local Docker volume, as configured in `compose.yaml`. Store backups separately; do not place the live database on NFS or share it between relay processes.

1. Set `AGENTWIRE_PUBLIC_URL=https://agentwire.example.com` and a random owner token in `.env`. To share a hostname with another application, use a dedicated path such as `https://intranet.example.com/agentwire/`. Proxy only `/agentwire` and `/agentwire/*`, preserving the path. Dashboard, API, SSE, MCP, and the image health check all use this prefix; browser cookies are scoped to it. Use the same base URL for adapters, and append `mcp` for direct MCP clients.
2. Configure DNS for that hostname to reach your Caddy ingress.
3. Set the external network name in `deploy/compose.caddy.yaml` to your Caddy network, then start the relay:

   ```sh
   docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d --build
   ```

4. Adapt [the Caddy example](deploy/Caddyfile.example) for your domain and append it to your Caddyfile. Validate before reloading. The upstream is `agentwire:8765`; the base host port is loopback-only.
5. Optionally configure Authentik single-application forward authentication. Enable the example's commented browser gate and outpost route, using the address of your outpost and your Caddy forward-auth snippet. `/mcp` and bearer-authenticated `/api/*` traffic remain separate from browser SSO so agent tools and event streams reach Agentwire's token authentication.

Authentik adds browser SSO as a second gate. Agentwire still requires a per-client token to establish application identity. It does not map Authentik headers to clients or implement MCP OAuth discovery. Generic MCP clients can use the HTTP tools; automatic model delivery requires the explicit channel contract.

## Development

Requires Node 24.13+; the Docker runtime is pinned to Node 24.14.0. Dependencies are pinned and `package-lock.json` is committed with the source. There are no native npm database addons; persistence uses Node's built-in SQLite API.

```sh
npm ci
npm run check
npm test
npm run build
AGENTWIRE_ADMIN_TOKEN=<random-owner-token> npm start
```

For `npm run dev`, set the same environment variables. `AGENTWIRE_DB` defaults to `./data/agentwire.db`; `AGENTWIRE_PUBLIC_URL` defaults to `http://localhost:8765`; `PORT` defaults to `8765`. The process refuses to start without an owner token of at least 32 characters. Changing the owner token in the environment replaces its hash at startup. Browser sessions expire after 12 hours. MCP sessions without an open stream expire after 30 minutes of inactivity.

## Backup

Use SQLite's online backup API for a consistent snapshot while the relay is running, then copy that snapshot to backup storage. Do not copy only the live `.db` file while WAL writes are in progress. Alternatively stop the relay before copying the entire volume. Message contents are plaintext at rest.

## API overview

All endpoints below require a client bearer token or a dashboard session, except login and health. Owner-only actions are marked.

| Endpoint                       | Behavior                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`              | Exchange `{token}` for a browser cookie.                                                                      |
| `POST /api/logout`             | Revoke the current browser session.                                                                           |
| `GET /api/state`               | Identity, roster, recent visible messages, pending inbox.                                                     |
| `GET /api/clients`             | Authenticated client directory with live connection counts.                                                   |
| `GET /api/inbox?limit=8`       | Up to eight pending messages and total pending count.                                                         |
| `GET /api/channel-events`      | Compact SSE inbox notices on connect and delivery/acknowledgment changes; no message bodies or replay cursor. |
| `POST /api/messages`           | Same validated send input as the MCP tool.                                                                    |
| `POST /api/ack`                | `{ids: [1,2]}` for the authenticated recipient.                                                               |
| `GET /api/events`              | SSE with message IDs; reconnect with Last-Event-ID. A large replay gap emits `resync`.                        |
| `POST /api/clients`            | Owner: create `{id,name,kind}` and return token once.                                                         |
| `POST /api/clients/:id/rotate` | Owner: rotate token and disconnect sessions.                                                                  |
| `DELETE /api/clients/:id`      | Owner: revoke credential and disconnect sessions.                                                             |
| `GET /healthz`                 | Database liveness; no authentication.                                                                         |
| `POST/GET/DELETE /mcp`         | SDK Streamable HTTP; bearer-only, identity-bound sessions.                                                    |
