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
    if (/^(INFERENCE_|SHARED_INFERENCE_|GEMINI_|OLLAMA_|REPLIT_|VERCEL)/.test(name)) delete process.env[name];
  }
  Object.assign(process.env, {
    SHARED_INFERENCE_PROVIDER: "ollama",
    SHARED_INFERENCE_URL: "https://shared.example/api/inference?provider=forged&provider=replit&model=forged",
    SHARED_INFERENCE_APP_SECRET: "test-app-secret",
    SHARED_INFERENCE_OLLAMA_API_KEY: "test-ollama-key",
    SHARED_INFERENCE_GEMINI_API_KEY: "test-gemini-key",
    SHARED_INFERENCE_REPLIT_API_KEY: "test-replit-key",
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

test("proxy owns identity, keys, provider/model and forwards only allowed top-level fields", async () => {
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
      messages, webSearch: false, options: { apiKey: "attacker" }, model: "gemma4:cloud",
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

test("each shared provider uses its own model setting and credentials", async () => {
  for (const [provider, setting, defaultModel] of [
    ["ollama", "OLLAMA_INFERENCE_MODEL", "gemma4:cloud"],
    ["gemini", "GEMINI_MODEL", "gemma-4-31b-it"],
    ["replit", "REPLIT_INFERENCE_MODEL", "google/gemma-4-26b-a4b-it"],
  ]) {
    process.env.SHARED_INFERENCE_PROVIDER = provider;
    process.env.INFERENCE_PROVIDER = "ignored";
    process.env.INFERENCE_MODEL = "ignored-legacy-model";
    process.env.GEMINI_FALLBACK_ENABLED = "false";
    for (const expected of [defaultModel, "custom/model"]) {
      if (expected === defaultModel) delete process.env[setting];
      else process.env[setting] = expected;
      globalThis.fetch = async (url, options) => {
        assert.equal(new URL(url).searchParams.get("provider"), provider);
        assert.equal(options.headers["X-Inference-Provider-Key"], `test-${provider}-key`);
        assert.equal(JSON.parse(options.body).model, expected);
        return Response.json({ content: "OK" });
      };
      assert.equal((await call()).statusCode, 200);
    }
  }
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
  process.env.GEMINI_API_KEY = "retained-direct-key";
  process.env.INFERENCE_API_KEY = "retained-direct-key";
  process.env.INFERENCE_PROVIDER = "ollama";
  process.env.INFERENCE_MODEL = "retained-direct-model";
  for (const name of ["SHARED_INFERENCE_PROVIDER", "SHARED_INFERENCE_URL", "SHARED_INFERENCE_APP_SECRET", "SHARED_INFERENCE_OLLAMA_API_KEY"]) {
    const value = process.env[name];
    delete process.env[name];
    for (const method of ["GET", "POST"]) assert.equal((await call({ method })).statusCode, 503);
    process.env[name] = value;
  }
  for (const provider of ["typo", "constructor"]) {
    process.env.SHARED_INFERENCE_PROVIDER = provider;
    assert.equal((await call()).body.error, "invalid_provider");
  }
  process.env.SHARED_INFERENCE_PROVIDER = "ollama";
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
      "SHARED_INFERENCE_URL=http://127.0.0.1:3001/api/inference",
      "SHARED_INFERENCE_APP_SECRET=local-loader-app-secret",
      "SHARED_INFERENCE_PROVIDER=replit",
      "SHARED_INFERENCE_REPLIT_API_KEY=local-loader-key",
      "REPLIT_INFERENCE_MODEL=custom/loader-model",
      "INFERENCE_FALLBACK_ENABLED=true",
      "INFERENCE_PROVIDER=gemini",
      "INFERENCE_API_KEY=obsolete-key",
      "INFERENCE_MODEL=obsolete-model",
      "SHARED_INFERENCE_ENABLED=false",
      "OLLAMA_API_KEY=obsolete-ollama-key",
      "GEMINI_API_KEY=obsolete-gemini-key",
      "OLLAMA_REQUESTS_PER_MINUTE=1",
      "GEMINI_FALLBACK_ENABLED=false",
      "VITE_SHARED_INFERENCE_APP_SECRET=must-not-load",
    ].join("\n"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(INFERENCE_|SHARED_INFERENCE_|GEMINI_|OLLAMA_|REPLIT_|VERCEL)/.test(key)));
    const script = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:3001/api/inference?provider=replit');
        assert.equal(init.headers.Authorization, 'Bearer local-loader-app-secret');
        assert.equal(init.headers['X-Inference-Provider-Key'], 'local-loader-key');
        assert.equal(JSON.parse(init.body).model, 'custom/loader-model');
        return Response.json({ content: 'OK' });
      };
      const { default: handler } = await import(${JSON.stringify(new URL("../api/inference.js", import.meta.url).href)});
      for (const key of ['INFERENCE_PROVIDER', 'INFERENCE_API_KEY', 'INFERENCE_MODEL',
        'SHARED_INFERENCE_ENABLED', 'OLLAMA_API_KEY', 'GEMINI_API_KEY',
        'OLLAMA_REQUESTS_PER_MINUTE', 'GEMINI_FALLBACK_ENABLED', 'VITE_SHARED_INFERENCE_APP_SECRET']) {
        assert.equal(process.env[key], undefined, key);
      }
      const res = {
        setHeader() {}, status(code) { assert.equal(code, 200); return this; },
        json(data) { assert.equal(data.content, 'OK'); },
      };
      await handler({ method: 'POST', headers: { host: 'example.test', origin: 'https://example.test', 'x-inference-client': 'loader-client' }, body: { messages: [{ role: 'user', content: 'Hello' }], webSearch: false } }, res);
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
  // The incoming body fits, but injecting the server-owned model exceeds 100k.
  const body = { messages: [{ role: "user", content: "😀".repeat(24_900) }], webSearch: false };
  body.messages[0].content += "x".repeat(100_000 - Buffer.byteLength(JSON.stringify(body)));
  const input = JSON.stringify(body);
  assert.equal(Buffer.byteLength(input), 100_000);
  assert.equal((await call({ body: input })).statusCode, 413);
});

test("invalid JSON, non-object bodies and invalid client headers stop at the proxy", async () => {
  for (const body of ["{", "null", [], 42]) {
    assert.equal((await call({ body })).statusCode, 400);
  }
  assert.equal((await call({ headers: { "x-inference-client": "" } })).body.error, "missing_client_token");
  assert.equal((await call({ headers: { "x-inference-client": "bad\r\nheader" } })).body.error, "invalid_client_token");
});

test("message, image and option semantics are delegated to the shared service", async () => {
  for (const fields of [
    {}, { messages: [] },
    { messages: [{ role: "assistant", content: "No user" }] },
    { messages: [{ role: "user", content: "x".repeat(60_001) }] },
    { messages: [{ role: "user", content: [{ type: "image", mediaType: "image/svg+xml", data: "invalid!" }] }] },
    { messages, options: [] }, { messages, options: { temperature: 3 } },
    { messages, options: { reasoningEffort: "invalid" } },
  ]) {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(init.body), { ...fields, model: "gemma4:cloud" });
      return Response.json({ error: "invalid_request" }, { status: 400 });
    };
    const result = await call({ body: fields });
    assert.equal(calls, 1);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: "invalid_request" });
  }
});

test("the proxy preserves service-supported search values and future nested options", async () => {
  const fields = { messages, webSearch: "false", options: { futureOption: { enabled: true } } };
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { ...fields, model: "gemma4:cloud" });
    return Response.json({ content: "Answer" });
  };
  assert.equal((await call({ body: fields })).statusCode, 200);
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
    assert.deepEqual(data.messages, conversation);
    return Response.json({ content: "Context", model: "gemma4:31b" });
  };
  assert.equal((await call({ body: { messages: conversation, webSearch: true, options: { temperature: 0.4, reasoningEffort: "high" } } })).statusCode, 200);
});

test("Gemini search requires an explicit server opt-in after validation", async () => {
  process.env.SHARED_INFERENCE_PROVIDER = "gemini";
  assert.equal((await call({ body: { messages, webSearch: true } })).body.error, "unsupported_capability");
  globalThis.fetch = async () => Response.json({ content: "OK" });
  assert.equal((await call()).statusCode, 200);
  process.env.SHARED_INFERENCE_GEMINI_SEARCH_ENABLED = "true";
  assert.equal((await call({ body: { messages, webSearch: true } })).statusCode, 200);
});

test("shared Replit selection uses only its backend key/model and preserves images/search/options", async () => {
  process.env.SHARED_INFERENCE_PROVIDER = "replit";
  process.env.INFERENCE_PROVIDER = "ollama";
  process.env.INFERENCE_MODEL = "old-legacy-model";
  process.env.GEMINI_MODEL = "gemini-only-model";
  process.env.OLLAMA_INFERENCE_MODEL = "ollama-only-model";
  const imageMessages = [{ role: "user", content: [
    { type: "image", mediaType: "image/png", data: "AQID" },
    { type: "text", text: "Describe and search" },
  ] }];
  let expectedModel = "google/gemma-4-26b-a4b-it";
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://shared.example/api/inference?provider=replit");
    assert.equal(init.headers["X-Inference-Provider-Key"], "test-replit-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, expectedModel);
    assert.deepEqual(body.messages, imageMessages);
    assert.equal(body.webSearch, true);
    assert.deepEqual(body.options, { reasoningEffort: "high", temperature: 0.3 });
    return Response.json({ content: "Replit answer", provider: "replit", model: body.model });
  };
  const body = { messages: imageMessages, webSearch: true, options: { reasoningEffort: "high", temperature: 0.3 }, provider: "gemini", model: "forged" };
  assert.equal((await call({ body })).statusCode, 200);
  expectedModel = "custom/model";
  process.env.REPLIT_INFERENCE_MODEL = expectedModel;
  assert.equal((await call({ body })).body.model, expectedModel);
});

test("Replit key/model settings fail closed without direct credentials", async () => {
  process.env.SHARED_INFERENCE_PROVIDER = "replit";
  process.env.REPLIT_API_KEY = "unused-legacy-key";
  delete process.env.SHARED_INFERENCE_REPLIT_API_KEY;
  assert.equal((await call()).body.error, "missing_api_key");
  process.env.SHARED_INFERENCE_REPLIT_API_KEY = "test-replit-key";
  process.env.REPLIT_INFERENCE_MODEL = "invalid model";
  assert.equal((await call()).body.error, "invalid_model");
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

test("hosted kill switch rejects GET and POST without contacting any upstream", async () => {
  for (const provider of ["ollama", "gemini", "replit"]) {
    process.env.SHARED_INFERENCE_PROVIDER = provider;
    for (const flag of ["false", "0", " OFF "]) {
      process.env.INFERENCE_FALLBACK_ENABLED = flag;
      for (const method of ["GET", "POST"]) {
        const result = await call({ method });
        assert.equal(result.statusCode, 503);
        assert.equal(result.body.error, "disabled");
      }
    }
  }
});

test("retired route switch never changes routing or allows a direct fallback", async () => {
  process.env.SHARED_INFERENCE_PROVIDER = "replit";
  process.env.OLLAMA_API_KEY = "obsolete-direct-key";
  process.env.GEMINI_API_KEY = "obsolete-direct-key";
  process.env.INFERENCE_API_KEY = "obsolete-direct-key";
  for (const flag of [undefined, "false", "0", "off", "true"]) {
    if (flag === undefined) delete process.env.SHARED_INFERENCE_ENABLED;
    else process.env.SHARED_INFERENCE_ENABLED = flag;
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://shared.example/api/inference?provider=replit");
      return Response.json({ content: "Shared answer" });
    };
    assert.equal((await call()).body.content, "Shared answer");
    const key = process.env.SHARED_INFERENCE_REPLIT_API_KEY;
    delete process.env.SHARED_INFERENCE_REPLIT_API_KEY;
    globalThis.fetch = () => { throw new Error("Missing configuration must gate fetch"); };
    for (const method of ["GET", "POST"]) assert.equal((await call({ method })).statusCode, 503);
    process.env.SHARED_INFERENCE_REPLIT_API_KEY = key;
  }
});

test("reasoning options pass through and absent options stay absent", async () => {
  for (const reasoningEffort of [undefined, "auto", "none", "low", "medium", "high"]) {
    const options = reasoningEffort === undefined ? undefined : { reasoningEffort };
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).options, options);
      return Response.json({ content: "Answer" });
    };
    assert.equal((await call({ body: { messages, webSearch: false, options } })).statusCode, 200);
  }
});
