import type { IncomingMessage } from "node:http";

/** Do not let a remote webpage or DNS rebinding use the local credential proxy. */
export function isLocalAdminRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (!address || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return false;
  try {
    const target = new URL(`http://${request.headers.host}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) return false;
    const origin = request.headers.origin;
    if (origin && origin !== target.origin) return false;
    return request.headers["sec-fetch-site"] !== "cross-site";
  } catch { return false; }
}
