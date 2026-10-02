import type { IncomingHttpHeaders } from "node:http";

interface DevApiRequest {
  readonly headers: IncomingHttpHeaders;
  readonly socket: { readonly localPort?: number };
}

interface DevApiProxyRequest {
  setHeader(name: string, value: string): void;
}

export function rewriteDevApiOrigin(proxyRequest: DevApiProxyRequest, request: DevApiRequest, apiOrigin: string): void {
  const port = request.socket.localPort;
  if (port === undefined) return;
  const origin = request.headers.origin;
  const expectedOrigin = URL.parse(`http://${request.headers.host ?? ""}`)?.origin;
  const devOrigins = new Set(["localhost", "127.0.0.1", "[::1]"].map((host) =>
    new URL(`http://${host}:${port}`).origin));
  if (origin !== undefined && origin === expectedOrigin && devOrigins.has(origin)) {
    proxyRequest.setHeader("origin", apiOrigin);
  }
}
