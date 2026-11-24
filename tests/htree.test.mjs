import assert from "node:assert/strict";
import test from "node:test";
import {
  HashTree,
  LinkType,
  MemoryStore,
  nhashEncode,
  toHex,
  visibilityHex,
} from "@hashtree/core";
import { nip19 } from "nostr-tools";
import {
  detectMediaMimeType,
  extractRootCidFromEvent,
  parseHtreeUrl,
  readHtreeMediaBytes,
} from "../src/htree.ts";
import { classifyUrl, htreeUriRegex } from "../src/media.ts";

const EXAMPLE_NHASH_URL =
  "htree://nhash1qqsfhmyh6rmela8esm9wjr4yv5k60yk48mt6rmh264tc7fn9570qxnq9yyqasrsxzatlgexxljuxqtrykqt39lrlnxjzsjzqwc9mszd6fm9lgsg09w5kl/1692-01.jpg";

test("parses immutable nhash htree URLs including the iris-social example", () => {
  const parsed = parseHtreeUrl(EXAMPLE_NHASH_URL);
  assert.ok(parsed);
  assert.equal(parsed.type, "nhash");
  assert.equal(
    toHex(parsed.cid.hash),
    "9bec97d0f79ff4f986cae90ea4652da792d53ed7a1eeead5578f2665a79e034c"
  );
  assert.equal(parsed.cid.key?.length, 33);
  assert.deepEqual(parsed.pathSegments, ["1692-01.jpg"]);
});

test("parses mutable npub htree URLs with percent-encoded tree names and #k link keys", () => {
  const pubkey = "0f45cbe562351c7211742fe02cc3e6f91d6cf5b306873c0f3e9fc0c570d3371c";
  const npub = nip19.npubEncode(pubkey);
  const linkKey =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
  const url = `htree://${npub}/my%2Fphotos/2026/summer%20pic.png?foo=bar#k=${linkKey}`;

  const parsed = parseHtreeUrl(url);
  assert.ok(parsed);
  assert.equal(parsed.type, "npub");
  assert.equal(parsed.pubkey, pubkey);
  assert.equal(parsed.treeName, "my/photos");
  assert.deepEqual(parsed.pathSegments, ["2026", "summer pic.png"]);
  assert.equal(parsed.linkKey, linkKey);
});

test("rejects malformed htree URLs and invalid percent encoding", () => {
  assert.equal(parseHtreeUrl("https://example.com/a.jpg"), null);
  assert.equal(parseHtreeUrl("htree://notvalid/a.jpg"), null);
  assert.equal(parseHtreeUrl("htree://nhash1invalid/a.jpg"), null);
  assert.equal(parseHtreeUrl(`${EXAMPLE_NHASH_URL}%ZZ`), null);

  const npub = nip19.npubEncode(
    "0f45cbe562351c7211742fe02cc3e6f91d6cf5b306873c0f3e9fc0c570d3371c"
  );
  // Missing tree name
  assert.equal(parseHtreeUrl(`htree://${npub}`), null);
});

test("classifies htree image and video URLs via extension or imeta, ignoring non-media trees", () => {
  assert.equal(classifyUrl(EXAMPLE_NHASH_URL), "image");
  assert.equal(
    classifyUrl(
      "htree://nhash1qqs2h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2cym3cqn/clip.mp4"
    ),
    "video"
  );
  assert.equal(
    classifyUrl(
      "htree://nhash1qqs2h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2cym3cqn/repo"
    ),
    null
  );

  // Bare nhash without extension still classifies via imeta
  const bare =
    "htree://nhash1qqs2h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2cym3cqn";
  assert.equal(classifyUrl(bare), null);
  assert.equal(
    classifyUrl(bare, [["imeta", `url ${bare}`, "m image/webp"]]),
    "image"
  );

  // Matches inside note content
  const matches = `1692. Myself\n\n${EXAMPLE_NHASH_URL}`.match(htreeUriRegex);
  assert.deepEqual(matches, [EXAMPLE_NHASH_URL]);
});

test("reads single-file encrypted nhash with advisory filename", async () => {
  const tree = new HashTree({ store: new MemoryStore() });
  // Minimal JPEG header bytes
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const { cid } = await tree.putFile(jpegBytes);
  const nhash = nhashEncode(cid);

  const result = await readHtreeMediaBytes(`htree://${nhash}/photo.jpg`, { tree });
  assert.ok(result);
  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(result.bytes, jpegBytes);

  // Rejects multi-segment path against a non-directory file root
  const invalid = await readHtreeMediaBytes(`htree://${nhash}/sub/photo.jpg`, {
    tree,
  });
  assert.equal(invalid, null);
});

test("reads file inside an encrypted directory tree via immutable nhash and mutable npub", async () => {
  const tree = new HashTree({ store: new MemoryStore() });
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { cid: fileCid, size } = await tree.putFile(pngBytes);
  const { cid: dirCid } = await tree.putDirectory([
    { name: "banner.png", cid: fileCid, size, type: LinkType.File },
  ]);

  // Immutable directory nhash
  const nhash = nhashEncode(dirCid);
  const immResult = await readHtreeMediaBytes(`htree://${nhash}/banner.png`, {
    tree,
  });
  assert.ok(immResult);
  assert.equal(immResult.mimeType, "image/png");
  assert.deepEqual(immResult.bytes, pngBytes);

  // Mutable npub with link-private #k=... key
  const pubkey = "0f45cbe562351c7211742fe02cc3e6f91d6cf5b306873c0f3e9fc0c570d3371c";
  const npub = nip19.npubEncode(pubkey);
  assert.ok(dirCid.key);
  const rootKeyHex = toHex(dirCid.key);
  const linkKeyHex = visibilityHex.generateLinkKey(
    dirCid.key.length === 33 ? 33 : 32
  );
  const encryptedKeyHex = visibilityHex.encryptKeyForLink(rootKeyHex, linkKeyHex);
  const keyIdHex = await visibilityHex.computeKeyId(linkKeyHex);

  const mockEvent = {
    id: "a".repeat(64),
    pubkey,
    created_at: 1795537448,
    kind: 30064,
    tags: [
      ["d", "media"],
      ["hash", toHex(dirCid.hash)],
      ["encryptedKey", encryptedKeyHex],
      ["keyId", keyIdHex],
    ],
    content: "",
    sig: "b".repeat(128),
  };

  const mutResult = await readHtreeMediaBytes(
    `htree://${npub}/media/banner.png#k=${linkKeyHex}`,
    {
      tree,
      fetchRootEvent: async () => mockEvent,
    }
  );
  assert.ok(mutResult);
  assert.equal(mutResult.mimeType, "image/png");
  assert.deepEqual(mutResult.bytes, pngBytes);

  // Without #k fragment, link-private root cannot be decrypted
  assert.equal(await extractRootCidFromEvent(mockEvent), null);
});

test("detects MIME type from extension and falls back to magic bytes", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectMediaMimeType("pic.webp", pngBytes), "image/webp");
  assert.equal(detectMediaMimeType(undefined, pngBytes), "image/png");
  assert.equal(detectMediaMimeType("noext", pngBytes), "image/png");
});
