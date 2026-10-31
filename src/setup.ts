import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { isDeepStrictEqual } from "node:util";

export async function setupClient(
  target: string,
  base: URL,
  cli: string,
  home = homedir(),
  node = process.execPath,
): Promise<string> {
  if (!["codex", "claude"].includes(target))
    throw new Error("Choose --client codex or --client claude");
  const path =
    target === "codex"
      ? join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml")
      : join(home, ".claude.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = {
    command: node,
    args: [
      cli,
      "adapter",
      "--url",
      base.href,
      "--name",
      target === "codex" ? "Codex" : "Claude Code",
    ],
    ...(target === "codex" ? { channel: true } : {}),
  };
  let updated: string;
  if (target === "claude") {
    const config = original ? JSON.parse(original) : {};
    config.mcpServers = { ...config.mcpServers, agentwire: server };
    updated = JSON.stringify(config, null, 2) + "\n";
  } else {
    const config = parse(original);
    const lines = original.split(/\r?\n/);
    let omit = false,
      found = false;
    const retained = lines
      .filter((line) => {
        if (/^\s*\[/.test(line)) {
          omit =
            /^\s*\[mcp_servers\.agentwire(?:\.[A-Za-z0-9_-]+)*\]\s*(?:#.*)?$/.test(
              line,
            );
          if (omit) found = true;
        }
        return !omit;
      })
      .join("\n");
    const servers = config.mcp_servers as Record<string, unknown> | undefined;
    if (servers?.agentwire && !found)
      throw new Error(
        "Agentwire uses a quoted or inline TOML table; edit that table explicitly before running setup",
      );
    updated =
      retained.trimEnd() +
      "\n\n" +
      stringify({ mcp_servers: { agentwire: server } });
    const result = parse(updated);
    // Validate that the targeted edit preserved every other TOML setting.
    if (servers) delete servers.agentwire;
    const resultServers = result.mcp_servers as Record<string, unknown>;
    delete resultServers.agentwire;
    if (!config.mcp_servers) delete result.mcp_servers;
    if (!isDeepStrictEqual(config, result))
      throw new Error("MCP configuration edit would change unrelated settings");
  }
  if (original === updated) return path;
  if (original)
    await writeFile(path + ".agentwire-backup-" + Date.now(), original, {
      mode: 0o600,
      flag: "wx",
    });
  // Fail if another process edited the settings during enrollment/setup.
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== original)
    throw new Error(
      "Client configuration changed during setup; run setup again",
    );
  const temporary = path + ".agentwire-" + randomUUID();
  await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}
