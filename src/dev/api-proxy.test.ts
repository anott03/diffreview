import { describe, expect, it, vi } from "vitest";
import { rewriteDevApiOrigin } from "./api-proxy";

const apiOrigin = "http://127.0.0.1:4777";

describe("Vite API proxy Origin rewrite", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("rewrites %s on the dev server's own port", (host) => {
    const setHeader = vi.fn();
    rewriteDevApiOrigin({ setHeader }, {
      headers: { host: `${host}:5173`, origin: `http://${host}:5173` },
      socket: { localPort: 5173 }
    }, apiOrigin);
    expect(setHeader).toHaveBeenCalledExactlyOnceWith("origin", apiOrigin);
  });

  it("uses the actual listening port when Vite falls back to another port", () => {
    const setHeader = vi.fn();
    rewriteDevApiOrigin({ setHeader }, {
      headers: { host: "localhost:5174", origin: "http://localhost:5174" },
      socket: { localPort: 5174 }
    }, apiOrigin);
    expect(setHeader).toHaveBeenCalledExactlyOnceWith("origin", apiOrigin);
  });

  it.each([
    { name: "foreign Origin", host: "localhost:5173", origin: "https://attacker.example", port: 5173 },
    { name: "null Origin", host: "localhost:5173", origin: "null", port: 5173 },
    { name: "no Origin", host: "localhost:5173", origin: undefined, port: 5173 },
    { name: "loopback Origin on the wrong port", host: "localhost:5173", origin: "http://localhost:4777", port: 5173 },
    { name: "matching Host and Origin on the wrong port", host: "localhost:4777", origin: "http://localhost:4777", port: 5173 },
    { name: "loopback Origin differing from Host", host: "localhost:5173", origin: "http://127.0.0.1:5173", port: 5173 },
    { name: "foreign Host and Origin on the right port", host: "attacker.example:5173", origin: "http://attacker.example:5173", port: 5173 },
    { name: "loopback-looking domain", host: "localhost.attacker.example:5173", origin: "http://localhost.attacker.example:5173", port: 5173 },
    { name: "foreign Host with loopback Origin", host: "attacker.example:5173", origin: "http://localhost:5173", port: 5173 },
    { name: "HTTPS Origin", host: "localhost:5173", origin: "https://localhost:5173", port: 5173 },
    { name: "missing Host", host: undefined, origin: "http://localhost:5173", port: 5173 },
    { name: "missing listening port", host: "localhost:5173", origin: "http://localhost:5173", port: undefined },
    { name: "old port after Vite fallback", host: "localhost:5173", origin: "http://localhost:5173", port: 5174 }
  ])("leaves $name untouched", ({ host, origin, port }) => {
    const setHeader = vi.fn();
    rewriteDevApiOrigin({ setHeader }, { headers: { host, origin }, socket: { localPort: port } }, apiOrigin);
    expect(setHeader).not.toHaveBeenCalled();
  });
});
