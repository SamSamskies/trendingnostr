import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

/** Block localhost, RFC1918, link-local, and cloud-metadata targets (SSRF). */
export function isPrivateOrLocalHostname(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "local" || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal" || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(":")) {
    if (
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      return true;
    }
    const mapped = /:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
    if (mapped) return isPrivateOrLocalHostname(mapped[1]);
  }

  return false;
}

function isIpLiteral(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  return host.includes(":");
}

/**
 * Resolve hostname once; reject if any answer is private/loopback.
 * @param {string} hostname
 * @returns {Promise<{ address: string, family: number }>}
 */
async function resolvePublicAddress(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (isIpLiteral(host)) {
    if (isPrivateOrLocalHostname(host)) throw new Error("unsafe_url");
    return { address: host, family: host.includes(":") ? 6 : 4 };
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("unsafe_url");
  }
  if (!addresses.length) throw new Error("unsafe_url");
  for (const { address } of addresses) {
    if (isPrivateOrLocalHostname(address)) {
      throw new Error("unsafe_url");
    }
  }
  return addresses[0];
}

/**
 * Parse and validate an absolute http(s) URL for server-side fetches.
 * Returns a pinned connect address so callers can avoid a second DNS lookup (rebinding).
 * @param {string} value
 * @param {string} [base]
 * @returns {Promise<{ url: URL, address: string, family: number }>}
 */
export async function assertSafeFetchUrl(value, base) {
  let parsed;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error("unsafe_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unsafe_url");
  }
  if (parsed.username || parsed.password) {
    throw new Error("unsafe_url");
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error("unsafe_url");
  }
  const { address, family } = await resolvePublicAddress(parsed.hostname);
  return { url: parsed, address, family };
}

/**
 * HTTP(S) GET that connects to the pre-validated IP while sending Host / TLS SNI
 * for the original hostname (closes DNS-rebinding TOCTOU).
 * @param {{ url: URL, address: string }} target
 * @param {{ signal?: AbortSignal, headers?: Record<string, string> }} [init]
 */
export function pinnedFetch(target, init = {}) {
  const { url, address } = target;
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  const sniHost = url.hostname.replace(/^\[|\]$/g, "");

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: address,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          ...(init.headers || {}),
          Host: url.host,
        },
        servername: isHttps ? sniHost : undefined,
        signal: init.signal,
      },
      (incoming) => {
        resolve({
          status: incoming.statusCode || 0,
          get ok() {
            const s = incoming.statusCode || 0;
            return s >= 200 && s < 300;
          },
          headers: {
            get(name) {
              const v = incoming.headers[String(name).toLowerCase()];
              if (v == null) return null;
              return Array.isArray(v) ? v.join(", ") : v;
            },
          },
          async text() {
            const chunks = [];
            for await (const chunk of incoming) {
              chunks.push(chunk);
            }
            return Buffer.concat(chunks).toString("utf8");
          },
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}
