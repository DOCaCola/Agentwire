# Agentwire development

Implement root-cause solutions. Do not add narrow workarounds, unnecessary
checks, silent fallbacks, or compatibility shims.

- Derive sender identity from credentials and enforce recipient visibility on
  every transport, including owner sessions.
- Commit messages and deliveries together before live publication.
- Clear inbox entries only after explicit processing acknowledgment.
- Keep the live SQLite database on local storage and run one relay process.
- Bound message bodies, query pages, stream buffers, and connection counts.
- Package all dashboard assets in the final image. Keep credentials out of
  URLs and browser storage.

Run `npm run check`, `npm test`, `npm run build`, and `npm run format:check`.
Validate image changes with Docker Compose and visible changes in a browser.
