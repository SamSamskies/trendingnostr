const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Candidate only; the checksum and BOLT11 structure are checked before rendering. */
export const lightningInvoiceRegex =
  /((?<![a-z0-9])(?:lightning:)?ln(?:bcrt|tbs|bc|tb)[a-z0-9]+)/gi;

export type LightningInvoice = {
  raw: string;
  uri: string;
  amount: string;
  network: string;
  expiresAt: number;
};

function polymod(values: number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    if (top & 1) check ^= 0x3b6a57b2;
    if (top & 2) check ^= 0x26508e6d;
    if (top & 4) check ^= 0x1ea119fa;
    if (top & 8) check ^= 0x3d4233dd;
    if (top & 16) check ^= 0x2a1462b3;
  }
  return check;
}

function readWords(words: number[]): number {
  return words.reduce((value, word) => value * 32 + word, 0);
}

function amountLabel(amount: string): string | null {
  if (!amount) return "Amount set by wallet";
  const match = /^(\d+)([munp]?)$/.exec(amount);
  if (!match) return null;
  const units = BigInt(match[1]);
  if (units === 0n) return null;
  const multiplier: Record<string, bigint> = {
    "": 100_000_000_000n,
    m: 100_000_000n,
    u: 100_000n,
    n: 100n,
  };
  // A pico-bitcoin is 0.1 millisat; BOLT11 requires whole millisats.
  if (match[2] === "p" && units % 10n !== 0n) return null;
  const msats = match[2] === "p" ? units / 10n : units * multiplier[match[2]];
  if (msats < 1000n) return `${Number(msats) / 1000} sat`;
  const sats = msats / 1000n;
  const remainder = msats % 1000n;
  return `${sats.toLocaleString()}${remainder ? `.${remainder.toString().padStart(3, "0").replace(/0+$/, "")}` : ""} sats`;
}

export function parseLightningInvoice(candidate: string): LightningInvoice | null {
  const raw = candidate.replace(/^lightning:/i, "");
  if (
    raw.length < 120 ||
    raw.length > 4096 ||
    (raw !== raw.toLowerCase() && raw !== raw.toUpperCase())
  ) return null;
  const lower = raw.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (separator < 4 || lower.length - separator - 1 < 7 + 104 + 6) return null;
  const hrp = lower.slice(0, separator);
  const networkMatch = /^ln(bcrt|tbs|bc|tb)(\d*[munp]?)$/.exec(hrp);
  if (!networkMatch) return null;
  const amount = amountLabel(networkMatch[2]);
  if (!amount) return null;

  const words = Array.from(lower.slice(separator + 1), (char) => ALPHABET.indexOf(char));
  if (words.some((word) => word < 0)) return null;
  const expanded = [
    ...Array.from(hrp, (char) => char.charCodeAt(0) >>> 5),
    0,
    ...Array.from(hrp, (char) => char.charCodeAt(0) & 31),
  ];
  if (polymod([...expanded, ...words]) !== 1) return null;

  const payload = words.slice(0, -6);
  const signatureStart = payload.length - 104;
  if (signatureStart < 7) return null;
  const timestamp = readWords(payload.slice(0, 7));
  let expiry = 3600;
  for (let index = 7; index < signatureStart;) {
    if (index + 3 > signatureStart) return null;
    const type = payload[index];
    const length = payload[index + 1] * 32 + payload[index + 2];
    index += 3;
    if (index + length > signatureStart) return null;
    if (type === ALPHABET.indexOf("x")) expiry = readWords(payload.slice(index, index + length));
    index += length;
  }
  if (!Number.isSafeInteger(expiry) || !Number.isSafeInteger(timestamp + expiry)) {
    return null;
  }

  const networks: Record<string, string> = {
    bc: "Bitcoin",
    tb: "Bitcoin testnet",
    tbs: "Bitcoin signet",
    bcrt: "Bitcoin regtest",
  };
  return {
    raw,
    uri: `lightning:${raw}`,
    amount,
    network: networks[networkMatch[1]],
    expiresAt: (timestamp + expiry) * 1000,
  };
}
