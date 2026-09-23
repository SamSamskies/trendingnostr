import assert from "node:assert/strict";
import test from "node:test";
import {
  applyZapObserverCorrections,
  fetchZapObserverCorrections,
  parseZapObserverTop,
  zapObserverRangeForHours,
} from "../lib/zapObserver.js";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_C = "c".repeat(64);

test("maps feed windows to zap.observer ranges that cover candidate ages", () => {
  assert.equal(zapObserverRangeForHours(4), "24h");
  assert.equal(zapObserverRangeForHours(12), "24h");
  assert.equal(zapObserverRangeForHours(24), "24h");
  assert.equal(zapObserverRangeForHours(48), "7d");
});

test("parses valid note totals and ignores malformed leaderboard rows", () => {
  assert.deepEqual(
    parseZapObserverTop({
      entries: [
        { key: ID_A.toUpperCase(), sats: 5_095 },
        { key: ID_A, sats: 5_000 },
        { key: "not-an-event", sats: 10_000 },
        { key: ID_B, sats: -1 },
        { key: ID_C, sats: "2100" },
      ],
    }),
    { [ID_A]: 5_095 }
  );
});

test("fetches both rankings and keeps partial corrections on board failure", async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(String(url));
    assert.ok(options.signal instanceof AbortSignal);
    const by = url.searchParams.get("by");
    if (by === "count") {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ entries: [{ key: ID_A, sats: 5_095 }] }),
    };
  };

  assert.deepEqual(await fetchZapObserverCorrections(12, fetchImpl), {
    [ID_A]: 5_095,
  });
  assert.equal(urls.length, 2);
  for (const rawUrl of urls) {
    const url = new URL(rawUrl);
    assert.equal(url.searchParams.get("range"), "24h");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.get("show"), "notes");
  }
  assert.deepEqual(
    new Set(urls.map((rawUrl) => new URL(rawUrl).searchParams.get("by"))),
    new Set(["sats", "count"])
  );
});

test("raises zap totals only for existing candidates", () => {
  const original = {
    [ID_A]: { reactions: 2, replies: 3, reposts: 4, zapAmount: 0 },
    [ID_B]: { reactions: 5, replies: 6, reposts: 7, zapAmount: 8_000 },
  };
  const corrected = applyZapObserverCorrections(
    [{ id: ID_A }, { id: ID_B }, { id: ID_C }],
    original,
    {
      [ID_A]: 5_095,
      [ID_B]: 2_100,
      [ID_C]: 1_000,
      ["d".repeat(64)]: 50_000,
    }
  );

  assert.deepEqual(corrected, {
    [ID_A]: { reactions: 2, replies: 3, reposts: 4, zapAmount: 5_095 },
    [ID_B]: { reactions: 5, replies: 6, reposts: 7, zapAmount: 8_000 },
    [ID_C]: { reactions: 0, replies: 0, reposts: 0, zapAmount: 1_000 },
  });
  assert.equal(original[ID_A].zapAmount, 0);
});
