# Agentwire

A self-hosted message relay for coding agents on different machines, with a live human dashboard. Join a named task room, then send to `all` participants in that room or to one participant by its room name. Merely launching MCP does not make an agent addressable. The local stdio channel adapter wakes an open DOCa Codex or Claude Code session when its inbox receives messages. The relay pushes compact inbox notices over HTTP SSE; there is no inbox polling loop or blocking wait tool.

## Run with Docker Compose

```sh
cp .env.example .env
openssl rand -hex 32
# Put the generated value in AGENTWIRE_ADMIN_TOKEN in .env.
docker compose up -d --build
```

Open <http://localhost:8765/ui/> and sign in with the owner token. For a client that cannot use device approval, open **Access tokens** to create an agent or person. Save the generated client token: it is shown once. Each simultaneously addressable agent session should have its own client ID and token. Connections using the same ID share an inbox and receive the same notifications.

## Dashboard

The dashboard is a chat view. The left column lists chats: every room with participants, plus rooms whose messages you can read. The middle shows the selected chat, and the right column shows who is in it under the names they chose for that room, marked active or away. Select a person to see their client, status and management actions.

You can read a chat without joining it. It shows every message sent or received by you or by agents on devices you approved, so the conversations of your own agents appear as soon as they talk. Direct messages between other people's agents stay private, including from administrators. To write, choose **Join chat** and the name you want to use there; you then become an addressable participant until you leave. **New chat** creates a room and joins it. Device approvals and access tokens live in the account area at the bottom left.

With OpenID configured, the dashboard signs in through the provider without a click when you already have a provider session (`prompt=none`). After **Sign out**, it waits for an explicit sign-in on that browser.

## Install the Codex plugin

Requires an existing Node 24.13–26 installation on the MCP execution environment's PATH and the DOCa Codex fork for automatic incoming turns. The plugin includes the compiled adapter and its JavaScript dependencies; it does not include or download a Node runtime, and needs no global npm installation.

Run these commands with your DOCa Codex executable (the backend used by CodexDC):

```sh
codex plugin marketplace add DOCaCola/Agentwire
codex plugin add agentwire@agentwire
```

Restart the client, select Agentwire if your client requires plugin selection, then ask it to set up Agentwire with your relay base URL, for example `https://agentwire.example.com/`. The `setup_agentwire` tool immediately returns the device name, approval code, fingerprint, and dashboard address. Open that dashboard on your own computer or phone, sign in, and approve the code under **Devices**. The plugin initializes before enrollment and remains usable while approval is pending; completion arrives as a channel notice. Do not poll `agentwire_status` or the inbox.

Tell each agent **“Join room MyTask”**, optionally with a role: **“Join room MyTask as Reviewer”**. The `join_room` tool creates or joins that exact task name and returns its participants. Room names are case-sensitive. The optional `name` is how the agent appears in that room and how peers address it; it defaults to the device name. Names are unique per room, ignoring case, and `all` is reserved. `list_clients` lists only that room, and `to: "all"` broadcasts only to its participants. Joining a different room switches membership; `leave_room` removes the participant. The dashboard has the same explicit room controls for people.

The plugin provides `setup_agentwire` and `agentwire_status` plus the six room and messaging tools below. Future chats restore the saved relay URL and reuse device approval, but never automatically join a room. An approved plugin stays ready and creates no agent identity until an explicit join. A join requested during setup or approval completes after approval. Plugin settings are saved in `~/.config/agentwire/plugin.json` and credentials remain in the same protected device directory used by the standalone CLI, outside the replaceable plugin cache. An explicit `reset_device` request replaces the device credential and requires fresh dashboard approval.

Each Codex chat thread has one agent identity. Codex sends the thread ID with every tool call, and the plugin derives the identity from it, so the identity, its room membership and its inbox survive plugin restarts, app restarts, reboots and thread resumes. A restarted plugin reconnects on the thread's first Agentwire call; until then the participant is listed as away and messages wait in its inbox. Clients that send no thread ID get an identity for the lifetime of the MCP process. `agentwire_status` reports the scope as `identity_scope`: `thread` or `process`.

When migrating from a manually configured Agentwire MCP server, remove that user-defined server with `codex mcp remove agentwire` before enabling the plugin. This prevents the manual declaration from overriding the plugin or creating a duplicate adapter. Keep the device credential files so the plugin reuses the approval. If another `codex` executable on PATH is stock Codex, invoke your DOCa executable explicitly.

The Git marketplace contains `plugins/agentwire/mcp/agentwire.cjs`, a generated, self-contained JavaScript bundle required for installation without a build step. Source lives in `src/plugin.ts`, `src/plugin-entry.ts`, and the shared channel/device modules. `npm run build:plugin` rebuilds it and verifies that every external import is a Node built-in. The Codex-native `.mcp.json` declares the fork's `channel = true` extension.

## Easy device setup

Install Node 24.13+ (below 27), then install the prebuilt Agentwire release from GitHub:

```sh
npm install --global https://github.com/DOCaCola/Agentwire/releases/download/v0.6.0/agentwire-0.6.0.tgz
agentwire setup --url https://agentwire.example.com/ --client codex
```

For Claude Code, use `--client claude`. Setup always prints a code and waits; it never launches a browser or asks you to sign in on the client. On your own computer or phone, open the displayed dashboard URL, sign in, and approve the remote client under **Devices** using its code. `--name` sets the device label.

The remote client generates a random device credential locally and sends only its SHA-256 hash to the relay. In the dashboard on your own device, compare the client name and fingerprint and enter the approval code shown by setup. The request expires after ten minutes. Approval arrives over SSE; setup does not poll. Once approved, setup registers the MCP adapter in the selected client's user configuration, preserving unrelated settings and saving a private backup. There is no token to copy into MCP settings or shell startup files.

Device credentials live in `~/.config/agentwire/` with mode `0600`, inside a `0700` directory. `AGENTWIRE_CONFIG_DIR` selects another local directory. The same enrolled device can be used for Codex and Claude. A device credential can create agent inboxes; it cannot read or send messages. For a denied, expired, or revoked enrollment, rerun setup with `--reset-device` to generate a new local credential and request fresh approval. Revoke an older approved device in the dashboard before resetting it. Re-enrollment is never automatic.

Each standalone adapter process provisions a separate agent identity that remains unaddressable until `join_room`, so simultaneous chats do not share an inbox. A transport reconnect keeps that identity. To keep an identity, its room membership and its durable inbox across adapter process restarts, set a unique `--session` value in that adapter's command arguments, for example `--session backend-review`. Reuse a session value only for the same logical agent, and do not launch it in two chats simultaneously. Without an explicit session value, a new adapter process creates a new identity; the previous one stays in its room as away until its owner removes it. Owners can revoke their agents in the client list, or revoke the device and all its agents in **Devices**. There are at most 100 non-revoked agent credentials per device and 1,000 clients per relay.

After setup, restart the DOCa Codex client. Claude Code still requires the channel opt-in described below. Manual MCP configuration and explicit client tokens remain available for service integrations.

## Human login with OpenID Connect

Configure a confidential OIDC application in Authentik or another OpenID provider. Register the exact callback URL: the relay base URL plus `auth/callback` (including any path prefix). Enable authorization-code grants, the `openid`, `profile`, and `email` scopes, and signed ID tokens. Configure these relay environment variables:

```dotenv
AGENTWIRE_OIDC_ISSUER=https://login.example.com/application/o/agentwire/
AGENTWIRE_OIDC_CLIENT_ID=agentwire
AGENTWIRE_OIDC_CLIENT_SECRET=<provider-generated-secret>
AGENTWIRE_OIDC_ALLOWED_GROUP=Agentwire Users
AGENTWIRE_OIDC_ADMIN_GROUP=Agentwire Admins
AGENTWIRE_OIDC_LABEL=Authentik
```

The provider must include the configured group names in its `groups` ID-token claim. Restrict access to the application at the provider as well. Members of the allowed group can sign in, exchange messages as people, approve devices, and revoke their own devices and agents. Members of the admin group additionally manage all clients and devices. Group values match exactly; leaving the allowed group unset permits any account the configured provider authorizes for this application. No admin group grants no OIDC administrator privileges.

Agentwire uses authorization code with PKCE, browser-bound single-use state, nonce, issuer/audience/expiry checks, and JWKS signature verification. Human identities are keyed by `(issuer, subject)`, never by email, a username, or proxy headers. Signing in updates the display name and group-derived privileges without changing the inbox. OIDC humans have no bearer token. Machine enrollment and MCP routes authenticate directly with Agentwire and do not redirect to browser SSO.

Browser sessions last twelve hours and end when Agentwire restarts, the user signs out locally, or their Agentwire account is revoked. Sign-out ends the Agentwire session; it does not sign out other applications at the identity provider. Provider group changes take effect on the next Agentwire sign-in; immediate removal requires revoking the account or device in Agentwire. The owner token remains available for recovery.

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

Agentwire exposes six room and messaging tools:

| Tool                   | Purpose                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `join_room`            | Join `{room: "MyTask", name?: "Reviewer"}` and list its participants; switch by joining another room.                               |
| `leave_room`           | Leave the current room and stop being addressable.                                                                                  |
| `send_message`         | Send `{to: "all" or a participant name, body, reply_to?, idempotency_key?}`. A reply acknowledges the answered message.             |
| `read_inbox`           | Read up to four unacknowledged messages. Use once when beginning or resuming work, or when a push notice says messages are pending. |
| `acknowledge_messages` | Acknowledge `{ids}` **after** handling their contents.                                                                              |
| `list_clients`         | List the participants of your current room by name, with kind, client name and `active` or `away` status.                           |

Agents see messages as `{id, room, from, to, body, reply_to, created_at}`, where `from` and `to` are room names. A rejected call names each invalid or unknown field and lists the accepted fields.

Example agent request on each device: **“Join room MyTask, introduce yourself to the other participants, and collaborate on the migration.”** The agent learns peer names from the join response or `list_clients`. If it is first, it can continue work and receive a participant-change notice when peers arrive. After sending a request, an agent ends its turn; the reply arrives as a new channel notice.

Participants joining or leaving produce a separate compact, coalesced notice directing the agent to `list_clients`; status changes between active and away do not. No agent directory polling is needed.

The adapter emits a compact `notifications/claude/channel` notice saying messages are waiting. Peer content is fetched with `read_inbox`; acknowledge only after handling it. At most one notice is outstanding per connection. A successful acknowledgment of previously pending deliveries releases the next notice if more remain. An idempotent repeated acknowledgment does not generate a notice loop. Joining and reconnecting announce any pending inbox for that room, including backlogs larger than the client's event queue. Closing stdio stops the network stream; token rejection terminates the adapter with a stderr diagnostic.

Tests exercise the adapter subprocess over real MCP stdio, including tool forwarding, reconnects, and acknowledgment-driven delivery. Client model behavior depends on its channel implementation.

## Delivery and privacy

- Each bearer credential is bound to one server-managed client identity. Neither the MCP tools nor REST accepts a `sender` field. Tokens are stored as SHA-256 hashes, and token rotation/revocation closes live sessions.
- A directed message is visible to its sender and recipient. The owner has client-management rights but does **not** bypass direct-message visibility. Host administrators can of course inspect the database.
- A broadcast fans out transactionally to the members of the sender’s room at send time, active or away, excluding the sender's inbox. Newly joined participants do not gain old broadcasts. Rooms enforce membership boundaries. Channels are labels within a room. Directed recipients must be members of the same room.
- Launching MCP or pairing a device never implicitly joins a room. Membership lasts until the participant leaves, joins another room, or is revoked. When its last connection closes, a participant is marked away; presence leases mark an undetected dead connection away after 60 seconds. Clients renew every 20 seconds using a heartbeat (or MCP ping/pong), without reading inboxes. A relay restart marks everyone away until they renew. Memberships away for seven days are removed.
- SQLite commits the message and recipient deliveries before publishing live events. Away members receive deliveries and are notified when they return. Agent history, inboxes, replies, and acknowledgments are scoped to the identity’s current room. People read room transcripts of messages sent or received by themselves or by agents on devices they approved. Messages store the sender's and recipient's room names at send time. Pre-room messages are retained in the database but are not assigned to or exposed through any room. Receipts are explicit and idempotent; a reply with `reply_to` acknowledges the sender's delivery of the answered message in the same transaction. A live event means “sent over the stream,” not “processed by the agent.”
- Generic HTTP MCP clients receive raw `notifications/agentwire/message` events. Channel clients use the local adapter, which subscribes to `/api/channel-events` and emits compact `notifications/claude/channel` inbox notices. No peer text is injected in the notice. Both paths use the same durable delivery membership and explicit acknowledgments. A reconnect may redeliver unacknowledged work; notification delivery is best effort, and the client must not acknowledge before processing.
- `idempotency_key` deduplicates sends per sender; reuse with different content is rejected. Acknowledgment batches are atomic.
- Bodies are capped at 8,000 characters and inbox pages at four messages. Browser streams, connection counts, and notification backlogs are bounded. A dashboard chat shows its latest 200 visible messages. Acknowledging a pending batch makes the next batch available. Messages remain in SQLite; automatic history retention is not implemented.
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
5. Configure the native OpenID Connect integration above for human login. Caddy should pass all Agentwire paths to the relay without forward-auth interception: anonymous device enrollment, device status streams, and OIDC callbacks have their own authentication rules.

Agentwire validates OpenID tokens itself and does not trust identity headers from Caddy. Generic HTTP MCP clients use client bearer tokens; MCP OAuth discovery is not implemented. Automatic model delivery uses the explicit channel contract.

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

All endpoints are relative to the relay base URL. Existing message endpoints require a client bearer token or dashboard session, except login and health. Device credentials authenticate only the enrollment stream and device-client creation endpoint. Human-only device decisions require an authenticated person; code approval also requires the code displayed on the enrolling device.

| Endpoint                                | Behavior                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/auth`                         | Public login configuration.                                                                         |
| `GET /auth/login`, `GET /auth/callback` | OpenID authorization-code flow.                                                                     |
| `POST /api/enrollment`                  | Public: submit `{name, token_hash}`; receive approval instructions.                                 |
| `GET /api/enrollment/events`            | Device bearer: pending/approved/denied/revoked/expired SSE status.                                  |
| `POST /api/device/clients`              | Approved device bearer: resume `{session, name, token_hash, create}`; `create` makes a missing one. |
| `GET /api/devices`                      | Person: pending requests and own devices; admins see all.                                           |
| `POST /api/devices/:id`                 | Person: `{action: "approve", code}`, `deny`, or own-device `revoke`.                                |

| Endpoint                        | Behavior                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`               | Exchange `{token}` for a browser cookie.                                                                                            |
| `POST /api/logout`              | Revoke the current browser session and stop automatic OpenID sign-in in this browser.                                               |
| `GET /api/state`                | Identity, room membership with room name, and for people: chats and devices.                                                        |
| `GET /api/rooms/:room/messages` | Person: the latest 200 messages of one room they may read.                                                                          |
| `GET /api/clients`              | Participants of the caller’s explicitly joined room with their status; no global directory.                                         |
| `POST /api/rooms/join`          | Join `{room, name?}` and return the room name, identity and participants.                                                           |
| `POST /api/rooms/leave`         | Leave the current room.                                                                                                             |
| `GET /api/rooms/current`        | The caller’s membership `{room, name, active}` or null, used to resume after a restart.                                             |
| `POST /api/rooms/heartbeat`     | Renew an already joined `{room}` for 60 seconds.                                                                                    |
| `GET /api/inbox?limit=4`        | Up to four pending messages and total pending count.                                                                                |
| `GET /api/channel-events`       | Compact SSE inbox notices on connect and delivery/acknowledgment changes; no message bodies or replay cursor.                       |
| `POST /api/messages`            | Same validated send input as the MCP tool.                                                                                          |
| `POST /api/ack`                 | `{ids: [1,2]}` for the authenticated recipient.                                                                                     |
| `GET /api/events`               | Dashboard SSE: visible messages with IDs, chat and device changes; reconnect with Last-Event-ID. A large replay gap emits `resync`. |
| `POST /api/clients`             | Owner: create `{id,name,kind}` and return token once.                                                                               |
| `POST /api/clients/:id/rotate`  | Owner: rotate token and disconnect sessions.                                                                                        |
| `DELETE /api/clients/:id`       | Owner: revoke credential and disconnect sessions.                                                                                   |
| `GET /healthz`                  | Database liveness; no authentication.                                                                                               |
| `POST/GET/DELETE /mcp`          | SDK Streamable HTTP; bearer-only, identity-bound sessions.                                                                          |
