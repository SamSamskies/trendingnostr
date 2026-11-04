import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler from "../api/inference.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const messages = [{ role: "system", content: "Explain" }, { role: "user", content: "Hello" }];
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (/^(INFERENCE_|SHARED_INFERENCE_|GEMINI_|OLLAMA_|VERCEL)/.test(name)) delete process.env[name];
  }
  Object.assign(process.env, {
    SHARED_INFERENCE_ENABLED: "true",
    SHARED_INFERENCE_URL: "https://shared.example/api/inference?provider=forged&provider=replit&model=forged",
    SHARED_INFERENCE_APP_SECRET: "test-app-secret",
    SHARED_INFERENCE_OLLAMA_API_KEY: "test-ollama-key",
    SHARED_INFERENCE_GEMINI_API_KEY: "test-gemini-key",
  });
  globalThis.fetch = () => { throw new Error("Unexpected fetch"); };
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

function request({ method = "POST", body = { messages, webSearch: false }, headers = {}, signal } = {}) {
  return Object.assign(new EventEmitter(), {
    method, body, signal,
    url: "/api/inference?provider=replit&provider=gemini&model=attacker",
    headers: { host: "example.test", origin: "https://example.test", "x-inference-client": "browser-uuid", ...headers },
  });
}
function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.writableFinished = true; return this; },
    end() { this.writableFinished = true; return this; },
  });
}
async function call(options) {
  const res = response();
  await handler(request(options), res);
  return res;
}

test("proxy owns identity, keys, provider/model and forwards only allowed fields", async () => {
  process.env.OLLAMA_API_KEY = "old-direct-key";
  process.env.GEMINI_API_KEY = "wrong-provider-key";
  process.env.OLLAMA_MODEL = "spam-only";
  process.env.INFERENCE_MODEL = "legacy-ignored-without-explicit-provider";
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://shared.example/api/inference?provider=ollama");
    assert.deepEqual(options.headers, {
      "X-Inference-App": "trendingnostr",
      Authorization: "Bearer test-app-secret",
      "X-Inference-Provider-Key": "test-ollama-key",
      "Content-Type": "application/json",
      "X-Inference-Client": "browser-uuid",
    });
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(JSON.parse(options.body), {
      messages, webSearch: false, options: {}, model: "gemma4:cloud",
    });
    return Response.json({ content: "Answer", model: "gemma4:31b", provider: "ollama" });
  };
  const res = await call({
    headers: {
      authorization: "Bearer attacker", "x-inference-app": "advancednostrsearch",
      "x-inference-provider-key": "attacker", cookie: "secret=cookie",
      "x-forwarded-host": "evil.example", "x-inference-provider": "replit", "x-inference-model": "attacker",
    },
    body: { messages, webSearch: false, model: "attacker", provider: "replit", stream: true,
      requiredCapabilities: ["reasoning"], options: { apiKey: "attacker" } },
  });
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.content, "Answer");
  assert.equal(res.headers["cache-control"], "no-store");
});

test("backend model precedence, provider credentials and direct-route kill switches remain intact", async () => {
  const cases = [
    { provider: "ollama", specific: "custom:cloud", legacy: "legacy", expected: "custom:cloud" },
    { provider: "ollama", legacy: "legacy", expected: "legacy" },
    { provider: "gemini", expected: "gemma-4-31b-it" },
    { provider: "gemini", specific: "gemini-2.5-flash", legacy: "legacy", expected: "gemini-2.5-flash" },
  ];
  for (const c of cases) {
    process.env.INFERENCE_PROVIDER = c.provider;
    delete process.env.OLLAMA_INFERENCE_MODEL;
    delete process.env.GEMINI_MODEL;
    delete process.env.INFERENCE_MODEL;
    if (c.specific) process.env[c.provider === "ollama" ? "OLLAMA_INFERENCE_MODEL" : "GEMINI_MODEL"] = c.specific;
    if (c.legacy) process.env.INFERENCE_MODEL = c.legacy;
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).searchParams.get("provider"), c.provider);
      assert.equal(options.headers["X-Inference-Provider-Key"], `test-${c.provider}-key`);
      assert.equal(JSON.parse(options.body).model, c.expected);
      return Response.json({ content: "OK" });
    };
    assert.equal((await call()).statusCode, 200);
  }
  process.env.GEMINI_FALLBACK_ENABLED = "false";
  assert.equal((await call()).body.error, "disabled");
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  assert.equal((await call()).statusCode, 200);
});

test("authenticated GET uses no client/model and passes through service availability", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://shared.example/api/inference?provider=ollama");
    assert.deepEqual(Object.keys(options.headers).sort(), ["Authorization", "X-Inference-App", "X-Inference-Provider-Key"]);
    assert.equal(options.body, undefined);
    assert.equal(options.method, "GET");
    return Response.json({ ok: false, error: "disabled" }, { status: 503 });
  };
  assert.deepEqual((await call({ method: "GET", headers: { origin: undefined } })).body, { ok: false, error: "disabled" });
});

test("methods, preflight and origins are enforced before any upstream work", async () => {
  assert.equal((await call({ method: "PUT" })).statusCode, 405);
  assert.equal((await call({ method: "OPTIONS" })).statusCode, 204);
  assert.equal((await call({ method: "OPTIONS", headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await call({ headers: { origin: undefined } })).statusCode, 403);
  assert.equal((await call({ headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await call({ method: "GET", headers: { origin: "https://evil.example" } })).statusCode, 403);
});

test("missing or invalid shared settings fail closed without using retained credentials", async () => {
  process.env.OLLAMA_API_KEY = "retained-direct-key";
  for (const name of ["SHARED_INFERENCE_URL", "SHARED_INFERENCE_APP_SECRET", "SHARED_INFERENCE_OLLAMA_API_KEY"]) {
    const value = process.env[name];
    delete process.env[name];
    assert.equal((await call({ method: "GET" })).statusCode, 503);
    process.env[name] = value;
  }
  for (const provider of ["replit", "typo"]) {
    process.env.INFERENCE_PROVIDER = provider;
    assert.equal((await call()).body.error, "invalid_provider");
  }
  delete process.env.INFERENCE_PROVIDER;
  process.env.OLLAMA_INFERENCE_MODEL = "invalid model";
  assert.equal((await call()).body.error, "invalid_model");
  delete process.env.OLLAMA_INFERENCE_MODEL;
  for (const url of ["http://external.example/api/inference", "https://user:pass@example.com/api/inference", "https://example.com/other", "https://example.com/api/inference#hash"]) {
    process.env.SHARED_INFERENCE_URL = url;
    assert.equal((await call()).body.error, "invalid_shared_config");
  }
});

test("local shared service on port 3001 works, with HTTP disallowed on deployments", async () => {
  process.env.SHARED_INFERENCE_URL = "http://127.0.0.1:3001/api/inference";
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:3001/api/inference?provider=ollama");
    return Response.json({ ok: true });
  };
  assert.equal((await call({ method: "GET" })).statusCode, 200);
  process.env.VERCEL_ENV = "preview";
  assert.equal((await call({ method: "GET" })).body.error, "invalid_shared_config");
});

test("backend local env loader includes every shared setting without browser prefixes", () => {
  const directory = mkdtempSync(join(tmpdir(), "trendingnostr-inference-env-"));
  try {
    writeFileSync(join(directory, ".env.local"), [
      "SHARED_INFERENCE_ENABLED=true",
      "SHARED_INFERENCE_URL=http://127.0.0.1:3001/api/inference",
      "SHARED_INFERENCE_APP_SECRET=local-loader-app-secret",
      "SHARED_INFERENCE_OLLAMA_API_KEY=local-loader-key",
    ].join("\n"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(INFERENCE_|SHARED_INFERENCE_|GEMINI_|OLLAMA_|VERCEL)/.test(key)));
    const script = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:3001/api/inference?provider=ollama');
        assert.equal(init.headers.Authorization, 'Bearer local-loader-app-secret');
        assert.equal(init.headers['X-Inference-Provider-Key'], 'local-loader-key');
        return Response.json({ ok: true });
      };
      const { default: handler } = await import(${JSON.stringify(new URL("../api/inference.js", import.meta.url).href)});
      const res = {
        setHeader() {}, status(code) { assert.equal(code, 200); return this; },
        json(data) { assert.equal(data.ok, true); },
      };
      await handler({ method: 'GET', headers: {} }, res);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, env });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("payload limits count UTF-8 bytes for raw, parsed and buffered bodies, including output injection", async () => {
  const huge = { messages: [{ role: "user", content: "😀".repeat(26_000) }] };
  for (const body of [huge, JSON.stringify(huge), Buffer.from(JSON.stringify(huge))]) {
    assert.equal((await call({ body })).statusCode, 413);
  }
  assert.equal((await call({ headers: { "content-length": "100001" } })).statusCode, 413);
  assert.equal((await call({ body: { messages: [{ role: "user", content: "x".repeat(60_001) }] } })).statusCode, 413);
  // The incoming body fits, but the server-owned model and options exceed 100k.
  const input = JSON.stringify({ messages: [{ role: "user", content: "😀".repeat(24_982) }], webSearch: false });
  assert.ok(Buffer.byteLength(input) <= 100_000);
  assert.equal((await call({ body: input })).statusCode, 413);
});

test("malformed messages, image parts, options, search flags and client tokens never reach upstream", async () => {
  for (const body of ["{", "null", [], {}, { messages: [] },
    { messages: [{ role: "assistant", content: "No user" }] },
    { messages: [{ role: "tool", content: "No tools" }] },
    { messages: [{ role: "user", content: [{ type: "image", url: "file:///etc/passwd" }] }] },
    { messages: [{ role: "user", content: [{ type: "image", url: "https://user:pass@images.test/a.png" }] }] },
    { messages: [{ role: "user", content: [{ type: "image", mediaType: "image/svg+xml", data: "AQID" }] }] },
    { messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "invalid!" }] }] },
    { messages, options: [] }, { messages, options: { temperature: 3 } },
    { messages, options: { reasoningEffort: "invalid" } }, { messages, webSearch: "false" },
  ]) assert.equal((await call({ body })).statusCode, 400);
  assert.equal((await call({ headers: { "x-inference-client": "" } })).body.error, "missing_client_token");
  assert.equal((await call({ headers: { "x-inference-client": "bad\r\nheader" } })).body.error, "invalid_client_token");
});

test("images, search, follow-ups and explicit reasoning options survive the proxy", async () => {
  const conversation = [messages[0], { role: "user", content: [
    { type: "image", url: "https://images.test/a.png", ignored: "extra" },
    { type: "image", mediaType: "image/png", data: "AQID" },
    { type: "text", text: "Describe" },
  ] }, { role: "assistant", content: "A red image" }, { role: "user", content: "Search for context" }];
  globalThis.fetch = async (_url, options) => {
    const data = JSON.parse(options.body);
    assert.deepEqual(data.options, { temperature: 0.4, reasoningEffort: "high" });
    assert.equal(data.webSearch, true);
    assert.deepEqual(data.messages[1].content[0], { type: "image", url: "https://images.test/a.png" });
    assert.deepEqual(data.messages.slice(2), conversation.slice(2));
    assert.equal(data.messages[1].content[1].data, "AQID");
    return Response.json({ content: "Context", model: "gemma4:31b" });
  };
  assert.equal((await call({ body: { messages: conversation, webSearch: true, options: { temperature: 0.4, reasoningEffort: "high" } } })).statusCode, 200);
});

test("Gemini search requires an explicit server opt-in after validation", async () => {
  process.env.INFERENCE_PROVIDER = "gemini";
  assert.equal((await call({ body: { messages, webSearch: true } })).body.error, "unsupported_capability");
  globalThis.fetch = async () => Response.json({ content: "OK" });
  assert.equal((await call()).statusCode, 200);
  process.env.SHARED_INFERENCE_GEMINI_SEARCH_ENABLED = "true";
  assert.equal((await call({ body: { messages, webSearch: true } })).statusCode, 200);
});

test("service errors, admission failures and Retry-After pass through without retries", async () => {
  for (const [status, data, retryAfter] of [
    [429, { error: "rate_limited" }, "60"],
    [429, { error: "client_limit" }, "Wed, 04 Nov 2026 18:00:00 GMT"],
    [503, { error: "rate_limit_unavailable" }, "5"],
    [503, { error: "provider_busy", http: 503 }, null],
    [401, { error: "unauthorized" }, null],
    [502, { error: "provider_auth" }, null],
  ]) {
    let count = 0;
    globalThis.fetch = async () => {
      count++;
      return Response.json(data, { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    };
    const res = await call();
    assert.equal(count, 1);
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.body, data);
    assert.equal(res.headers["retry-after"], retryAfter || undefined);
  }
});

test("credential echoes and transport errors stay out of responses and logs", async () => {
  const logs = [];
  mock.method(console, "warn", (...args) => logs.push(args));
  mock.method(console, "error", (...args) => logs.push(args));
  globalThis.fetch = async () => Response.json({ content: "test-app-secret test-ollama-key", nested: { error: "test-ollama-key" } });
  const res = await call();
  assert.equal(res.body.content, "[redacted] [redacted]");
  assert.deepEqual(res.body.nested, { error: "[redacted]" });
  globalThis.fetch = async () => { throw new Error("test-app-secret test-ollama-key"); };
  assert.deepEqual((await call()).body, { error: "provider_error" });
  assert.deepEqual(logs, []);
});

test("redirects and malformed upstream JSON produce sanitized errors", async () => {
  for (const result of [new Response("bad", { status: 502 }), new Response("", { status: 302 }), Response.json(null)]) {
    globalThis.fetch = async () => result;
    assert.equal((await call()).statusCode, 502);
  }
});

test("timeout covers response body, exceeds the shared deadline and fits the function duration", async () => {
  const controller = new AbortController();
  mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 180_000);
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url)));
    assert.ok(config.functions["api/inference.js"].maxDuration * 1000 > ms);
    return controller.signal;
  });
  globalThis.fetch = async (_url, { signal }) => ({
    status: 200, headers: new Headers(),
    async json() {
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      signal.throwIfAborted();
    },
  });
  const res = await call();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "provider_busy");
});

test("browser disconnect and explicit abort cancel upstream and remove event listeners", async () => {
  for (const event of ["aborted", "close", "signal"]) {
    const controller = new AbortController();
    const req = request({ signal: controller.signal });
    const res = response();
    globalThis.fetch = async (_url, { signal }) => {
      if (event === "signal") controller.abort();
      else if (event === "aborted") req.emit("aborted");
      else { res.destroyed = true; res.emit("close"); }
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
    };
    await handler(req, res);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
    if (event !== "close") assert.equal(res.statusCode, 499);
    else assert.equal(res.body, null);
  }
});

test("independent rollback uses the retained direct provider without shared credentials", async () => {
  process.env.OLLAMA_API_KEY = "direct-key";
  process.env.OLLAMA_REQUESTS_PER_MINUTE = "100";
  for (const enabled of [undefined, "false", "0", "off"]) {
    if (enabled === undefined) delete process.env.SHARED_INFERENCE_ENABLED;
    else process.env.SHARED_INFERENCE_ENABLED = enabled;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://ollama.com/api/chat");
      assert.equal(options.headers.Authorization, "Bearer direct-key");
      assert.equal(JSON.parse(options.body).model, "gemma4:31b");
      return Response.json({ message: { role: "assistant", content: "Direct answer" }, done: true });
    };
    const result = await call({ headers: { "x-inference-client": crypto.randomUUID() } });
    assert.equal(result.body.content, "Direct answer", JSON.stringify(result.body));
  }
});
