/** A relay may live at an origin or under a dedicated reverse-proxy path. */
export function relayUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname)
  ) {
    throw new Error(
      "Relay URL must be HTTP(S) with an optional path prefix, without credentials, query, or fragment",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
