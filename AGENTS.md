# Agentwire development

Implement root-cause solutions that fit the design. Do not add narrow workarounds,
unnecessary defensive checks, silent fallbacks, or compatibility shims.

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
