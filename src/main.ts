import { createAgentwire } from "./app.js";

const port = Number(process.env.PORT ?? "8765");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be 1..65535");
const wire = createAgentwire({
  database: process.env.AGENTWIRE_DB ?? "./data/agentwire.db",
  adminToken: process.env.AGENTWIRE_ADMIN_TOKEN ?? "",
  publicUrl: process.env.AGENTWIRE_PUBLIC_URL ?? `http://localhost:${port}`,
  ...(process.env.AGENTWIRE_OIDC_ISSUER
    ? {
        oidc: {
          issuer: process.env.AGENTWIRE_OIDC_ISSUER,
          clientId: process.env.AGENTWIRE_OIDC_CLIENT_ID ?? "",
          clientSecret: process.env.AGENTWIRE_OIDC_CLIENT_SECRET ?? "",
          adminGroup: process.env.AGENTWIRE_OIDC_ADMIN_GROUP,
          allowedGroup: process.env.AGENTWIRE_OIDC_ALLOWED_GROUP,
          label: process.env.AGENTWIRE_OIDC_LABEL,
        },
      }
    : {}),
});
const server = wire.app.listen(port, process.env.HOST ?? "0.0.0.0", () =>
  console.log(`Agentwire listening on port ${port}`),
);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.on("error", async (error) => {
  console.error(error.message);
  await wire.close();
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    server.close();
    await wire.close();
    server.closeAllConnections();
  });
