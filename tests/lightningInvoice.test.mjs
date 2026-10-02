import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "uqr";
import { lightningInvoiceRegex, parseLightningInvoice } from "../src/lightningInvoice.ts";

const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function checksum(hrp, data) {
  const values = [
    ...Array.from(hrp, (char) => char.charCodeAt(0) >>> 5),
    0,
    ...Array.from(hrp, (char) => char.charCodeAt(0) & 31),
    ...data,
    0, 0, 0, 0, 0, 0,
  ];
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
  const result = check ^ 1;
  return Array.from({ length: 6 }, (_, i) => (result >>> (5 * (5 - i))) & 31);
}

function words(value, length) {
  return Array.from({ length }, (_, i) => Math.floor(value / 32 ** (length - 1 - i)) % 32);
}

// A structurally valid BOLT11 fixture with an unsigned dummy signature.
function invoice({ hrp = "lnbc5u", timestamp = 1_700_000_000, expiry } = {}) {
  const data = [...words(timestamp, 7)];
  if (expiry !== undefined) {
    const encoded = words(expiry, 2);
    data.push(alphabet.indexOf("x"), 0, encoded.length, ...encoded);
  }
  data.push(...Array(104).fill(0));
  return `${hrp}1${[...data, ...checksum(hrp, data)].map((word) => alphabet[word]).join("")}`;
}

test("recognizes a checksummed invoice and preserves its payment payload", () => {
  const raw = invoice({ expiry: 120 });
  const parsed = parseLightningInvoice(raw);
  assert.equal(parsed?.amount, "500 sats");
  assert.equal(parsed?.network, "Bitcoin");
  assert.equal(parsed?.expiresAt, (1_700_000_000 + 120) * 1000);
  assert.equal(parsed?.uri, `lightning:${raw}`);
  assert.equal(parseLightningInvoice(`lightning:${raw}`)?.raw, raw);
  assert.ok(encode(parsed.uri, { ecc: "M", border: 0 }).data.length);
});

test("encodes long bolt11 URIs that exceed the old custom QR version-16 cap", () => {
  // Real invoice with routing hints (~520 chars with lightning: prefix).
  const raw =
    "lnbc50u1p4tljr3pp59evll3qv0874v855w7gwk4jus53m0a65veeentuksfncd03t7ftssp5kcmjm95vap0lytalldy82gvlmz8fx6gc5v3clypkeskyhnmqm35sxqrrssnp4qvyndeaqzman7h898jxm98dzkm0mlrsx36s93smrur7h0azyyuxc5rzjq25carzepgd4vqsyn44jrk85ezrpju92xyrk9apw4cdjh6yrwt5jgqqqqrt49lmtcqqqqqqqqqqq86qq9qrzjqv72ze400mf93pw4sw04upankedqs9usl64ps3nndaf2wpmkp7w3napyqr6zgqqqq8hxk2qqae4jsqyugqcqzpudquvd6hqgr0vcsxxmmxvejk2g8znz2s9qyyssqcuyvdzf4rhnyxfw476fmt9sgx9sq8r56plyf8axy5j52f4u62gc3v3d9zgmqqmscq9k95vu3z7kayp2r0hzepju7rpc7tr3j0fv9fnqqkwngww";
  const parsed = parseLightningInvoice(raw);
  assert.ok(parsed);
  assert.ok(parsed.uri.length > 450);
  const { data, version } = encode(parsed.uri, { ecc: "M", border: 0 });
  assert.ok(version > 16);
  assert.ok(data.length >= 21 + 4 * (version - 1));
});

test("uses the one-hour default and handles testnet and sub-sat amounts", () => {
  const parsed = parseLightningInvoice(invoice({ hrp: "lntb1n" }));
  assert.equal(parsed?.network, "Bitcoin testnet");
  assert.equal(parsed?.amount, "0.1 sat");
  assert.equal(parsed?.expiresAt, (1_700_000_000 + 3600) * 1000);
});

test("does not turn arbitrary or corrupt text into a payment card", () => {
  const raw = invoice();
  assert.equal(parseLightningInvoice(raw.slice(0, -1) + "q"), null);
  assert.equal(parseLightningInvoice(raw.replace("5u", "5p")), null);
  assert.equal(parseLightningInvoice("lnbc123"), null);
  assert.deepEqual(`before ${raw} after`.split(lightningInvoiceRegex), ["before ", raw, " after"]);
  assert.deepEqual(`word${raw}`.split(lightningInvoiceRegex), [`word${raw}`]);
});
