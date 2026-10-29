import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  createHostedBackend,
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
