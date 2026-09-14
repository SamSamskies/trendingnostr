import type { Kind0Profile } from "./identity";

export const PAYTO_KIND = 10133;

export type PaymentTarget = {
  id: string;
  type: string;
  label: string;
  address: string;
  uri: string;
  openable: boolean;
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
    const target = makeTarget("lightning", profile.lud16);
    if (target) targets.push(target);
  }
  if (profile.sp) {
    const target = makeTarget("bip352", profile.sp);
    if (target) targets.push(target);
  }
  return targets;
}

export function paymentTargetsFromPaytoTags(tags: string[][]): PaymentTarget[] {
  const targets: PaymentTarget[] = [];
  for (const tag of tags) {
    if (tag[0] !== "payto" || tag.length < 3) continue;
    const target = makeTarget(tag[1], tag[2]);
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

function makeTarget(rawType: string, rawAddress: string): PaymentTarget | null {
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
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_ADDRESS_LEN ||
    /[\s<>"']/.test(trimmed)
  ) {
    return null;
  }

  if (type === "lightning") return normalizeLightning(trimmed);
  if (type === "bip352") {
    const sp = trimmed.toLowerCase();
    return SP_RE.test(sp) ? sp : null;
  }
  return trimmed;
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
