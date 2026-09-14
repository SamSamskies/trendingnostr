import type { Kind0Profile } from "./identity";

export const PAYTO_KIND = 10133;

export type PaymentTargetSource = "profile" | "payto";

export type PaymentTarget = {
  id: string;
  type: string;
  label: string;
  address: string;
  uri: string;
  openable: boolean;
  source: PaymentTargetSource;
};

export type PaymentTargetDetails = {
  sourceLabel: string;
  network: string | null;
  amount: string | null;
};

const BECH32_CHAR = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const SP_RE = new RegExp(`^(sp|tsp)1[${BECH32_CHAR}]{40,130}$`);
const TYPE_RE = /^[a-z][a-z0-9]{0,31}$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_ADDRESS_LEN = 256;

const TYPE_ALIASES: Record<string, string> = {
  lightning: "lightning",
  lud16: "lightning",
  bip352: "bip352",
  sp: "bip352",
};

const TYPE_LABELS: Record<string, string> = {
  lightning: "Lightning",
  bip352: "Silent payment",
  bip353: "Bitcoin DNS",
  bitcoin: "Bitcoin",
  bitcoincash: "Bitcoin Cash",
  cashme: "Cash App",
  ethereum: "Ethereum",
  litecoin: "Litecoin",
  monero: "Monero",
  nano: "Nano",
  paypal: "PayPal",
  revolut: "Revolut",
  solana: "Solana",
  tron: "Tron",
  venmo: "Venmo",
  zcash: "Zcash",
};

const SCHEME_TYPES = new Set([
  "bitcoin",
  "bitcoincash",
  "ethereum",
  "lightning",
  "litecoin",
  "monero",
  "nano",
  "solana",
  "tron",
  "zcash",
]);

const TYPE_ORDER = [
  "lightning",
  "bip352",
  "bitcoin",
  "bip353",
  "bitcoincash",
  "litecoin",
  "ethereum",
  "solana",
  "monero",
  "zcash",
  "nano",
  "tron",
  "cashme",
  "paypal",
  "venmo",
  "revolut",
];

export function hasProfilePaymentTargets(
  profile: Kind0Profile | undefined
): boolean {
  return Boolean(profile?.lud16 || profile?.sp);
}

export function paymentTargetsFromProfile(
  profile: Kind0Profile | undefined
): PaymentTarget[] {
  if (!profile) return [];
  const targets: PaymentTarget[] = [];
  if (profile.lud16) {
    const target = makeTarget("lightning", profile.lud16, "profile");
    if (target) targets.push(target);
  }
  if (profile.sp) {
    const target = makeTarget("bip352", profile.sp, "profile");
    if (target) targets.push(target);
  }
  return targets;
}

export function paymentTargetsFromPaytoTags(tags: string[][]): PaymentTarget[] {
  const targets: PaymentTarget[] = [];
  for (const tag of tags) {
    if (tag[0] !== "payto" || tag.length < 3) continue;
    const target = makeTarget(tag[1], tag[2], "payto");
    if (target) targets.push(target);
  }
  return targets;
}

export function mergePaymentTargets(
  ...groups: PaymentTarget[][]
): PaymentTarget[] {
  const seen = new Set<string>();
  const out: PaymentTarget[] = [];
  for (const group of groups) {
    for (const target of group) {
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      out.push(target);
    }
  }
  out.sort((a, b) => typeRank(a.type) - typeRank(b.type));
  return out;
}

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type);
  return index < 0 ? TYPE_ORDER.length : index;
}

function makeTarget(
  rawType: string,
  rawAddress: string,
  source: PaymentTargetSource
): PaymentTarget | null {
  const type = canonicalType(rawType);
  if (!type) return null;
  const address = normalizeAddress(type, rawAddress);
  if (!address) return null;
  const uri = paymentUri(type, address);
  return {
    id: `${type}:${address.toLowerCase()}`,
    type,
    label: TYPE_LABELS[type] ?? titleType(type),
    address,
    uri,
    source,
    // Raw addresses (silent payments) and payto:// are copy/QR only.
    openable: /^(https?|lightning|bitcoin|bitcoincash|ethereum|litecoin|monero|nano|solana|tron|zcash):/i.test(
      uri
    ),
  };
}

function canonicalType(raw: string): string | null {
  const type = raw.trim().toLowerCase();
  if (!TYPE_RE.test(type)) return null;
  return TYPE_ALIASES[type] ?? type;
}

function normalizeAddress(type: string, raw: string): string | null {
  const decoded = decodeAuthority(raw.trim());
  if (
    !decoded ||
    decoded.length > MAX_ADDRESS_LEN ||
    /[\s<>"']/.test(decoded)
  ) {
    return null;
  }

  if (type === "lightning") return normalizeLightning(decoded);
  if (type === "bip352") {
    const sp = decoded.toLowerCase();
    return SP_RE.test(sp) ? sp : null;
  }
  return decoded;
}

/**
 * NIP-A3 authorities may already be percent-encoded. Decode once so URI
 * assembly encodes a single canonical form (avoids %40 → %2540).
 */
function decodeAuthority(value: string): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeLightning(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (lower.startsWith("lnurl1") || lower.startsWith("lnbc")) {
    if (!/^[a-z0-9]+$/.test(lower)) return null;
    return lower;
  }
  const at = lower.lastIndexOf("@");
  if (at <= 0 || at === lower.length - 1) return null;
  const local = lower.slice(0, at).trim();
  const host = lower
    .slice(at + 1)
    .trim()
    .replace(/\.$/, "");
  if (!local || !host || host.includes("@")) return null;
  return `${local}@${host}`;
}

function paymentUri(type: string, address: string): string {
  if (type === "bip352" || type === "bip353") return address;
  if (type === "lightning") return `lightning:${address}`;
  if (type === "cashme") {
    const tag = address.startsWith("$") ? address : `$${address}`;
    if (/^\$[a-zA-Z0-9._-]{1,32}$/.test(tag)) return `https://cash.app/${tag}`;
  }
  if (type === "paypal" && USERNAME_RE.test(address)) {
    return `https://paypal.me/${address}`;
  }
  if (type === "venmo" && USERNAME_RE.test(address)) {
    return `https://venmo.com/${address}`;
  }
  if (type === "revolut" && USERNAME_RE.test(address)) {
    return `https://revolut.me/${address}`;
  }
  if (SCHEME_TYPES.has(type)) return `${type}:${address}`;
  return `payto://${type}/${encodeURIComponent(address)}`;
}

function titleType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Human-readable source / network / amount for the tip confirmation strip. */
export function paymentTargetDetails(
  target: PaymentTarget
): PaymentTargetDetails {
  const sourceLabel =
    target.source === "profile" ? "Profile (kind 0)" : "Payto (kind 10133)";
  const parsed = describePaymentPayload(target);
  return {
    sourceLabel,
    network: parsed.network,
    amount: parsed.amount,
  };
}

function describePaymentPayload(target: PaymentTarget): {
  network: string | null;
  amount: string | null;
} {
  if (target.type === "lightning") {
    if (target.address.startsWith("lnurl1")) {
      return { network: "Lightning", amount: "Set by wallet" };
    }
    const invoice = describeBolt11(target.address);
    if (invoice) return invoice;
    return { network: "Lightning", amount: "Any amount" };
  }
  if (target.type === "bip352") {
    return {
      network: target.address.startsWith("tsp1")
        ? "Bitcoin testnet"
        : "Bitcoin",
      amount: "Any amount",
    };
  }
  if (target.type === "bip353") {
    return { network: "Bitcoin DNS", amount: "Resolved by wallet" };
  }
  if (target.type === "bitcoin") {
    return { network: "Bitcoin", amount: "Any amount" };
  }
  if (SCHEME_TYPES.has(target.type) || TYPE_LABELS[target.type]) {
    return {
      network: TYPE_LABELS[target.type] ?? titleType(target.type),
      amount: "Any amount",
    };
  }
  return { network: titleType(target.type), amount: null };
}

/**
 * Minimal BOLT11 humanizer for tip confirmation (mainnet / testnet / signet).
 * Amount parsing mirrors the zap-receipt helper in nostr.ts.
 */
function describeBolt11(invoice: string): {
  network: string;
  amount: string;
} | null {
  const lower = invoice.toLowerCase();
  let network: string | null = null;
  let prefixLen = 0;
  if (lower.startsWith("lnbcrt")) {
    network = "Bitcoin regtest";
    prefixLen = 6;
  } else if (lower.startsWith("lntbs")) {
    network = "Bitcoin signet";
    prefixLen = 5;
  } else if (lower.startsWith("lntb")) {
    network = "Bitcoin testnet";
    prefixLen = 4;
  } else if (lower.startsWith("lnbc")) {
    network = "Bitcoin";
    prefixLen = 4;
  } else {
    return null;
  }

  if (lower.length < 50) {
    return { network, amount: "Invoice" };
  }
  const head = lower.slice(0, 50);
  const sep = head.lastIndexOf("1");
  if (sep < prefixLen) return { network, amount: "Invoice" };
  const amount = head.slice(prefixLen, sep);
  if (!amount) return { network, amount: "Any amount" };

  const multipliers: Record<string, number> = {
    m: 1e5,
    u: 1e2,
    n: 0.1,
    p: 0.0001,
  };
  const last = amount[amount.length - 1]!;
  let sats: number;
  if (last in multipliers) {
    const n = Number(amount.slice(0, -1));
    if (!Number.isFinite(n) || n < 0) return { network, amount: "Invoice" };
    sats = Math.floor(n * multipliers[last]!);
  } else {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return { network, amount: "Invoice" };
    sats = Math.floor(n * 1e8);
  }
  if (sats <= 0) return { network, amount: "Any amount" };
  return { network, amount: `${sats.toLocaleString()} sats (fixed)` };
}
