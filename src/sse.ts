import type { Response } from "express";

/** A bounded HTTP event connection shared by dashboard and channel subscribers. */
export function eventStream(res: Response) {
  res.set({
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!res.write(": keepalive\n\n")) res.end();
  }, 20_000).unref();
  const expiry = setTimeout(
    () => res.end(),
    res.locals.sessionExpires
      ? res.locals.sessionExpires - Date.now()
      : 12 * 60 * 60_000,
  ).unref();
  res.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(expiry);
  });
  return {
    send(type: string, data: unknown, id?: number) {
      if (res.writableEnded) return;
      if (
        !res.write(
          `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
        )
      )
        res.end();
    },
  };
}
