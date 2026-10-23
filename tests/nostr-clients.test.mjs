import assert from "node:assert/strict";
import test from "node:test";
import {
  clientHref,
  clientOpenHref,
  clientsForPlatform,
  isWebClientHref,
  NOSTR_CLIENTS,
} from "../src/nostr-clients.ts";

const nevent = "nevent1qqstexample";
const npub = "npub1example";

function client(id) {
  return NOSTR_CLIENTS.find((entry) => entry.id === id);
}

test("Nostur opens the App Store instead of an unregistered custom scheme", () => {
  const nostur = client("nostur");
  assert.equal(clientHref(nostur, nevent), "nostur:nevent1qqstexample");
  assert.equal(
    clientOpenHref(nostur, nevent),
    "https://apps.apple.com/app/id1672780508"
  );
  assert.ok(isWebClientHref(clientOpenHref(nostur, nevent)));
  assert.equal(client("nos"), undefined);
});

test("Damus and Primal iOS use https so a missing app does not error in Safari", () => {
  assert.equal(clientOpenHref(client("damus"), nevent), "https://damus.io/nevent1qqstexample");
  assert.equal(
    clientOpenHref(client("primal-ios"), nevent),
    "https://primal.net/e/nevent1qqstexample"
  );
  assert.equal(
    clientOpenHref(client("primal-ios"), npub, "profile"),
    "https://primal.net/p/npub1example"
  );
});

test("iOS Open In list still includes native apps and default handler", () => {
  const ids = clientsForPlatform("ios").map((entry) => entry.id);
  assert.deepEqual(
    ids.slice(0, 4),
    ["native", "damus", "nostur", "primal-ios"]
  );
  assert.equal(clientOpenHref(client("native"), nevent), "nostr:nevent1qqstexample");
});
