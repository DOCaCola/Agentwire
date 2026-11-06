import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { EventSource } from "eventsource";
import { z } from "zod";
import { relayUrl } from "./url.js";

export const credentialSchema = z
  .object({
    url: z.string(),
    name: z.string().min(1).max(80),
    token: z.string().regex(/^aw_[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type DeviceCredential = z.infer<typeof credentialSchema>;
export async function resetDeviceCredential(
  url: URL,
  directory = process.env.AGENTWIRE_CONFIG_DIR ??
    join(homedir(), ".config", "agentwire"),
) {
  const file = join(
    directory,
    createHash("sha256").update(url.href).digest("hex") + ".json",
  );
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export function clientUrl(value: string): URL {
  const url = relayUrl(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127\.\d+\.\d+\.\d+$/.test(url.hostname))
    )
  )
    throw new Error("Agentwire requires HTTPS except on loopback");
  return url;
}
export async function deviceCredential(
  url: URL,
  directory = process.env.AGENTWIRE_CONFIG_DIR ??
    join(homedir(), ".config", "agentwire"),
  name = hostname(),
): Promise<DeviceCredential> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(
    directory,
    createHash("sha256").update(url.href).digest("hex") + ".json",
  );
  try {
    const credential = credentialSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    if (credential.url !== url.href)
      throw new Error("Device credential belongs to another relay");
    return credential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credential = {
    url: url.href,
    name,
    token: "aw_" + randomBytes(32).toString("base64url"),
  };
  const temporary = file + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(credential) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, file);
  } catch (error) {
    // Concurrent adapters share one enrollment; only the exclusive creator writes the credential.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return deviceCredential(url, directory, name);
  } finally {
    await unlink(temporary);
  }
  return credential;
}
export async function deviceRequest(
  url: URL,
  path: string,
  token: string | undefined,
  body: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result = (await response.json()) as { error: string };
    throw new Error(`Agentwire HTTP ${response.status}: ${result.error}`);
  }
  return response.json();
}
export const enrollmentSchema = z.object({
  status: z.enum(["pending", "approved"]),
  user_code: z.string(),
  verification_url: z.string().url(),
  expires_at: z.number(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;

export async function requestEnrollment(
  credential: DeviceCredential,
  signal: AbortSignal,
): Promise<Enrollment> {
  const url = clientUrl(credential.url);
  return enrollmentSchema.parse(
    await deviceRequest(
      url,
      "api/enrollment",
      undefined,
      {
        name: credential.name,
        token_hash: createHash("sha256").update(credential.token).digest("hex"),
      },
      signal,
    ),
  );
}

export async function enrollDevice(
  credential: DeviceCredential,
  report: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const enrollment = await requestEnrollment(credential, signal);
  if (enrollment.status === "approved") return;
  report(
    `Device: ${credential.name}\nApproval code: ${enrollment.user_code.slice(0, 4)}-${enrollment.user_code.slice(4)}\nDevice fingerprint: ${createHash("sha256").update(credential.token).digest("hex").slice(0, 16)}\n\nOn your own computer or phone, open:\n${enrollment.verification_url}\nSign in there, open Devices, and approve this client using the code above.\nThis client needs no browser or login. Waiting for remote approval…`,
  );
  await waitForEnrollment(credential, enrollment, signal);
  report("Device approved.");
}

export async function waitForEnrollment(
  credential: DeviceCredential,
  enrollment: Enrollment,
  signal: AbortSignal,
): Promise<void> {
  const url = clientUrl(credential.url);
  await new Promise<void>((resolve, reject) => {
    const stream = new EventSource(new URL("api/enrollment/events", url), {
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          redirect: "manual",
          signal,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            Authorization: `Bearer ${credential.token}`,
          },
        });
        if (response.status >= 500 || response.status === 429) {
          await response.body?.cancel();
          // EventSource retries transport failures; it must not close on a temporary HTTP error.
          throw new Error("Enrollment event connection unavailable");
        }
        return response;
      },
    });
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            "Device approval expired; run setup again with a new credential",
          ),
        ),
      Math.max(1, enrollment.expires_at - Date.now()),
    );
    function finish(error?: Error) {
      clearTimeout(timeout);
      stream.close();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    }
    function abort() {
      finish(new Error("Device enrollment cancelled"));
    }
    signal.addEventListener("abort", abort, { once: true });
    stream.addEventListener("enrollment", (event) => {
      try {
        const { status } = z
          .object({
            status: z.enum([
              "pending",
              "approved",
              "denied",
              "revoked",
              "expired",
            ]),
          })
          .strict()
          .parse(JSON.parse(event.data));
        if (status === "approved") finish();
        else if (status !== "pending")
          finish(new Error(`Device enrollment ${status}`));
      } catch {
        finish(new Error("Invalid device enrollment event"));
      }
    });
    stream.onerror = (event) => {
      if (event.code !== undefined || stream.readyState === EventSource.CLOSED)
        finish(
          new Error(
            `Device enrollment connection rejected (HTTP ${event.code})`,
          ),
        );
    };
    if (signal.aborted) abort();
  });
}
/**
 * Derives the agent token for one device-local session. The same session always yields the
 * same identity; with create false an unknown session returns a null client.
 */
export async function agentCredential(
  credential: DeviceCredential,
  name: string,
  signal: AbortSignal,
  session: string,
  create: boolean,
) {
  const token =
    "aw_" +
    createHmac("sha256", credential.token)
      .update("agentwire-session:" + session)
      .digest("base64url");
  const { client } = z
    .object({
      client: z.object({ id: z.string(), name: z.string() }).nullable(),
    })
    .parse(
      await deviceRequest(
        clientUrl(credential.url),
        "api/device/clients",
        credential.token,
        {
          session,
          name,
          token_hash: createHash("sha256").update(token).digest("hex"),
          create,
        },
        signal,
      ),
    );
  return { token, client };
}
