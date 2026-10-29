import assert from "node:assert/strict";
import test from "node:test";
import { withOpaqueProviderHint } from "../src/inference-errors.ts";

test("opaque provider errors get a retry hint", () => {
  assert.equal(
    withOpaqueProviderHint("Provider returned error"),
    "Provider returned error. Retry in a moment or pick another model — busy or free-tier models often fail this way.",
  );
  assert.equal(
    withOpaqueProviderHint("  server tool request failed  "),
    "server tool request failed. The model's web search or other hosted tool failed — retry, pick another model, or turn off web search.",
  );
});

test("detailed IPA provider errors stay intact", () => {
  const detailed =
    "Provider returned error (Together): qwen/qwen3:free is temporarily rate-limited upstream.";
  assert.equal(withOpaqueProviderHint(detailed), detailed);
});
