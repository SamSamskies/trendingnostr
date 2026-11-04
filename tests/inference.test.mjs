import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  createHostedBackend,
  getOrCreateClientToken,
  hasHostedConsent,
  setHostedConsent,
} from "../src/hosted-backend.ts";
import { canSearchWeb, completeChat } from "../src/inference.ts";
import { setWebSearchEnabled } from "../src/settings.ts";

const originalFetch = globalThis.fetch;
const originals = Object.fromEntries(
  ["window", "location", "localStorage", "sessionStorage"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function setup() {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  globalThis.location = { origin: "https://example.test" };
  globalThis.window = { isSecureContext: true };
  setWebSearchEnabled(true);
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key];
    else Object.defineProperty(globalThis, key, value);
  }
});
async function drain(stream) {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  return result;
}

const messages = [
  { role: "system", content: "Explain a note" },
  { role: "user", content: "Hello Nostr" },
];

test("text-only IPA with hosted consent can search on the image fallback path", async () => {
  setup();
  setHostedConsent(true);
  window.inference = {
    getFeatures: () => ({}),
    async *request() {
      throw new Error("IPA must not handle consented image fallback");
    },
  };
  let posted;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "GET") return Response.json({ ok: true });
    posted = JSON.parse(options.body);
    return Response.json({ content: "Hosted vision answer" });
  };
  assert.equal(canSearchWeb(false), false);
  assert.equal(canSearchWeb(true), true);
  const result = await completeChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { type: "text", text: "Describe this" },
        ],
      },
    ],
  });
  assert.equal(result.content, "Hosted vision answer");
  assert.equal(posted.webSearch, true);
});

test("hosted web search follows the request tools snapshot, not a live toggle", async () => {
  setup();
  setHostedConsent(true);
  setWebSearchEnabled(false);
  let posted;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "GET") return Response.json({ ok: true });
    posted = JSON.parse(options.body);
    return Response.json({ content: "Hosted answer" });
  };
  const session = await createHostedBackend().create();
  await drain(
    session.request({
      method: "chat",
      messages,
      tools: [{ type: "web_search" }],
    }),
  );
  assert.equal(posted.webSearch, true);
  setWebSearchEnabled(true);
  await drain(session.request({ method: "chat", messages }));
  assert.equal(posted.webSearch, false);
});

test("hosted consent and existing storage keys gate requests without changing client identity", async () => {
  setup();
  globalThis.fetch = () => { throw new Error("Consent must gate fetch"); };
  const session = await createHostedBackend().create();
  await assert.rejects(drain(session.request({ method: "chat", messages })), /consent required/);
  assert.equal(hasHostedConsent(), false);
  setHostedConsent(true);
  assert.equal(sessionStorage.getItem("trendingnostr.inferenceConsent"), "1");
  const token = getOrCreateClientToken();
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(localStorage.getItem("trendingnostr.inferenceClient"), token);
  assert.equal(getOrCreateClientToken(), token);
  setHostedConsent(false);
  assert.equal(sessionStorage.getItem("trendingnostr.inferenceConsent"), null);
  assert.equal(getOrCreateClientToken(), token);
});

test("hosted follow-ups preserve image/options/signal and count only successful non-streaming responses", async () => {
  setup();
  setHostedConsent(true);
  const signal = new AbortController().signal;
  const conversation = [messages[0], { role: "user", content: [
    { type: "image", url: "https://images.test/a.png" }, { type: "text", text: "Describe" },
  ] }, { role: "assistant", content: "An image" }, { role: "user", content: "Why?" }];
  const options = { reasoningEffort: "high", temperature: 0.4 };
  let failed = true;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/inference");
    assert.equal(init.signal, signal);
    assert.deepEqual(JSON.parse(init.body), { messages: conversation, webSearch: false, options });
    assert.equal(init.headers["X-Inference-Client"], getOrCreateClientToken());
    return failed ? Response.json({ error: "rate_limited" }, { status: 429 }) :
      Response.json({ content: "Explanation", model: "hosted-model" });
  };
  const session = await createHostedBackend().create();
  const req = { method: "chat", messages: conversation, options, signal };
  await assert.rejects(drain(session.request(req)), /rate_limited/);
  assert.equal(localStorage.getItem("trendingnostr.inferenceSoftCount"), null);
  failed = false;
  const chunks = await drain(session.request(req));
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["accepted", "done"]);
  assert.equal(chunks[1].message.content, "Explanation");
  assert.equal(JSON.parse(localStorage.getItem("trendingnostr.inferenceSoftCount")).count, 1);
});

test("the existing daily soft count blocks hosted fetch at 50 successes", async () => {
  setup();
  setHostedConsent(true);
  localStorage.setItem("trendingnostr.inferenceSoftCount", JSON.stringify({
    day: new Date().toISOString().slice(0, 10), count: 50,
  }));
  globalThis.fetch = () => { throw new Error("Soft allowance must gate fetch"); };
  const session = await createHostedBackend().create();
  await assert.rejects(drain(session.request({ method: "chat", messages })), /client_limit/);
});

test("available IPA stays preferred over consented hosted inference", async () => {
  setup();
  setHostedConsent(true);
  let requests = 0;
  window.inference = {
    getFeatures: () => ({ webSearch: true, imageInput: true }),
    async *request(req) {
      requests++;
      assert.deepEqual(req.messages, messages);
      yield { type: "accepted" };
      yield { type: "done", model: "ipa-model", message: { role: "assistant", content: "IPA answer" } };
    },
  };
  globalThis.fetch = () => { throw new Error("Available IPA must handle request"); };
  const result = await completeChat({ messages });
  assert.equal(requests, 1);
  assert.equal(result.content, "IPA answer");
});

test("platform WAF and shared-service failures retain retryable browser errors without counting successes", async () => {
  setup();
  setHostedConsent(true);
  const session = await createHostedBackend().create();
  for (const [response, expected] of [
    [new Response("Rate limited", { status: 429 }), /rate_limited/],
    [Response.json({ error: "quota_exhausted" }, { status: 429 }), /quota_exhausted/],
    [Response.json({ error: "client_limit" }, { status: 429 }), /client_limit/],
    [Response.json({ error: "rate_limit_unavailable" }, { status: 503 }), /provider_busy/],
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(drain(session.request({ method: "chat", messages })), expected);
    assert.equal(localStorage.getItem("trendingnostr.inferenceSoftCount"), null);
  }
});
