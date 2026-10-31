# Agentwire development

Implement root-cause solutions that fit the design. Do not add narrow workarounds,
unnecessary defensive checks, silent fallbacks, or compatibility shims.

- Device setup and MCP initialization never imply room participation. Only explicit
  join intent creates an active participant; discovery, fan-out, direct sends,
  history, inboxes and acknowledgments must respect the current room.
- Sender identity comes from authentication, never caller-supplied message fields.
- REST, MCP, dashboard events, history, and acknowledgments must enforce the same
  delivery membership. Owner rights do not bypass directed-message visibility.
- Commit messages and recipient deliveries in one SQLite transaction before
  publishing notifications. Live delivery does not acknowledge processing.
- Keep the SQLite database on local storage. Do not run multiple relay replicas.
- Use SDK Streamable HTTP for remote MCP clients and SDK stdio for the local
  Claude-compatible channel adapter. Do not add inbox polling or repurpose
  logging/progress notifications as chat events.
- Preserve bounded message bodies, query pages, connection counts, and buffers.
- Device secrets are generated and kept on the client. Enrollment sends hashes;
  approval requires a signed-in human and the device's displayed code. A device
  credential can provision its agents but cannot access any message inbox.
- OpenID identity is `(issuer, subject)`. Validate state, nonce, PKCE, signed ID
  tokens, and configured groups. Never link by email or trust proxy identity
  headers. Revoking a device or human must revoke all affected agent credentials.
- Plugin MCP initialization must complete before relay discovery or device approval.
  Setup returns pairing information and waits over SSE in the background. Keep
  plugin settings and credentials outside the installation cache.
- Build the tracked plugin JavaScript bundle from source; it includes dependencies
  but no runtime. Verify it works without node_modules beside the installed file.
- The current DOCa fork supports idle wakeup through `channel = true` and the
  stdio Claude channel contract. Its removed `surface_notifications` path is not
  supported. Keep notices compact and coalesced; see README.md.
- Package dashboard assets in the final image; keep credentials out of URLs and
  browser storage. Never trust proxy identity headers without a designed identity
  integration.

Validate with `npm run check`, `npm test`, `npm run build`, and
`npm run format:check`. For image or packaging changes, build the image and verify
its health check and dashboard assets with Docker Compose. Inspect visible UI
changes in a browser at desktop and mobile sizes.
