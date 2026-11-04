/** Public-proxy smoke; no provider/app credentials needed. */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  url: { type: "string" },
  vision: { type: "boolean", default: false },
  search: { type: "boolean", default: false },
  checks: { type: "boolean", default: false },
  provider: { type: "string" },
  "image-url": { type: "string" },
  "image-expect": { type: "string" },
  "follow-up": { type: "boolean", default: false },
} });
if (!values.url) throw new Error("Usage: npm run smoke:inference -- --url https://HOST/api/inference [--provider replit] [--checks] [--vision | --image-url URL --image-expect TEXT] [--search] [--follow-up]");
if (values.provider && !["ollama", "gemini", "replit"].includes(values.provider)) throw new Error("Invalid expected provider");
if (values["image-url"] && (values.vision || !values["image-expect"]?.trim())) throw new Error("External images require --image-expect TEXT and cannot be combined with --vision");
if (values["image-expect"] && !values["image-url"]) throw new Error("--image-expect requires --image-url");
const endpoint = new URL(values.url);
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || endpoint.pathname !== "/api/inference") throw new Error("Invalid proxy URL");
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const headers = {
  "Content-Type": "application/json",
  Origin: endpoint.origin,
  "X-Inference-Client": crypto.randomUUID(),
  ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
};
async function request(method, body, extra = {}, query = "") {
  const response = await fetch(endpoint.href + query, {
    method, headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error", signal: AbortSignal.timeout(195_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Proxy returned non-JSON HTTP ${response.status}`); }
  if (bypass) assert.ok(!JSON.stringify(data).includes(bypass), "Credential echo in proxy response");
  return { status: response.status, data };
}
const messages = [{ role: "user", content: "Reply with the word ready." }];
const probe = await request("GET");
assert.equal(probe.status, 200, "Availability probe failed");
assert.equal(probe.data.ok, true);
if (values.checks) {
  for (const [method, body, extra, status] of [
    ["PUT", undefined, {}, 405],
    ["POST", { messages, webSearch: false }, { Origin: "https://invalid-origin.example" }, 403],
    ["POST", { messages: [], webSearch: false }, {}, 400],
    ["POST", { messages, webSearch: false, options: { temperature: 10 } }, {}, 400],
    ["POST", { messages, webSearch: false }, { "X-Inference-Client": "" }, 400],
    ["POST", { messages: [{ role: "user", content: "😀".repeat(26_000) }], webSearch: false }, {}, 413],
  ]) {
    const result = await request(method, body, extra);
    assert.equal(result.status, status, `Negative ${method} check failed`);
  }
  console.log("PASS: methods, origin, prompt/options/client validation and UTF-8 limit");
}

// An inline image avoids external image hosts. It is a 64x64 red PNG.
let image = { type: "image", mediaType: "image/png", data:
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC" };
if (values["image-url"]) {
  const url = new URL(values["image-url"]);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Image URL must use HTTPS without credentials");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, "Image download failed");
  assert.match(response.headers.get("content-type") || "", /^image\/(jpeg|png|webp|gif)(?:;|$)/i);
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= 4_000_000, "Image exceeds the shared service's 4 MB image budget");
  }
  assert.ok(bytes > 1_000_000, "Full-size smoke requires an image over 1 MB before base64 encoding");
  console.log(`PASS: full-size image is ${bytes} bytes (${4 * Math.ceil(bytes / 3)} base64 bytes upstream)`);
  // Send only the URL: the shared service must download and encode the image.
  image = { type: "image", url: url.href };
}
const hasImage = values.vision || Boolean(values["image-url"]);
const prompt = [
  ...(values.vision ? ["Describe the color in this image in one short sentence."] : []),
  ...(values["image-url"] ? ["Describe the main subject of this image and any prominent text in a few sentences."] : []),
  ...(values.search ? ["Search the web for the official Nostr protocol repository. Include an HTTPS source link."] : []),
].join(" ") || "Reply with the word ready.";
const conversation = [{ role: "user", content: hasImage ? [image, { type: "text", text: prompt }] : prompt }];
const generated = await request("POST", {
  messages: conversation,
  webSearch: values.search,
  // Browser selectors must have no effect on the backend-owned provider/model.
  provider: "forged-provider", model: "forged-model", stream: true,
}, {
  Authorization: "Bearer smoke-forged-auth",
  "X-Inference-App": "smoke-forged-app",
  "X-Inference-Provider-Key": "smoke-forged-key",
}, "?provider=forged-provider&provider=second-forgery&model=forged-model");
assert.equal(generated.status, 200, "Generation failed; inspect sanitized status/error metadata in the deployment");
assert.ok(typeof generated.data.content === "string" && generated.data.content.trim(), "Missing content");
assert.ok(typeof generated.data.model === "string" && generated.data.model !== "forged-model", "Invalid backend model");
if (values.provider) assert.equal(generated.data.provider, values.provider, "Unexpected backend provider");
for (const forged of ["smoke-forged-auth", "smoke-forged-key", "smoke-forged-app"]) {
  assert.ok(!JSON.stringify(generated.data).includes(forged), "Forged credential echo");
}
if (values.search) assert.match(generated.data.content, /https:\/\//, "Search smoke requires an HTTPS citation");
if (values.vision) assert.match(generated.data.content, /\bred\b/i, "Vision smoke requires the correct image color");
if (values["image-expect"]) assert.ok(generated.data.content.toLowerCase().includes(values["image-expect"].trim().toLowerCase()), "Image description must match the expected visible subject/text");
console.log(`PASS: generation, backend selectors, non-streaming JSON${values.provider ? `, provider ${values.provider}` : ""}${hasImage ? ", image content" : ""}${values.search ? ", search citation (inspect provider usage to confirm search execution)" : ""}`);
if (values["follow-up"]) {
  const followup = await request("POST", {
    messages: [...conversation, { role: "assistant", content: generated.data.content },
      { role: "user", content: "Summarize your previous answer in one sentence." }],
    webSearch: false,
  });
  assert.equal(followup.status, 200, "Follow-up failed");
  assert.ok(typeof followup.data.content === "string" && followup.data.content.trim(), "Missing follow-up content");
  if (values.provider) assert.equal(followup.data.provider, values.provider);
  console.log("PASS: follow-up with retained conversation and search disabled");
}
