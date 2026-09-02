import { lookup } from "node:dns/promises";

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
 * Resolve hostname and reject private/loopback answers (DNS rebinding / wildcard SSRF).
 * @param {string} hostname
 */
async function assertPublicDns(hostname) {
  if (isIpLiteral(hostname)) return;

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("unsafe_url");
  }
  if (!addresses.length) throw new Error("unsafe_url");
  for (const { address } of addresses) {
    if (isPrivateOrLocalHostname(address)) {
      throw new Error("unsafe_url");
    }
  }
}

/**
 * Parse and validate an absolute http(s) URL for server-side fetches.
 * WHATWG URL already canonicalizes decimal/octal/hex IP literals; DNS is checked too.
 * @param {string} value
 * @param {string} [base]
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
  await assertPublicDns(parsed.hostname);
  return parsed;
}
