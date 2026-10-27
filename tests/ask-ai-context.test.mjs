import assert from "node:assert/strict";
import test from "node:test";
import {
  patchNoteContextHistory,
  preferredResponseLanguage,
  systemPrompt,
} from "../src/ask-ai-context.ts";

test("response language uses browser preference order and language fallback", () => {
  assert.equal(
    preferredResponseLanguage({ languages: ["es-MX", "en-US"], language: "fr" }),
    "es-MX",
  );
  assert.equal(
    preferredResponseLanguage({ languages: [], language: "fr-CA" }),
    "fr-CA",
  );
  assert.equal(preferredResponseLanguage({ language: "pt-br" }), "pt-BR");
  assert.equal(
    preferredResponseLanguage({
      languages: ["", "not_a_locale", "ja"],
      language: "en",
    }),
    "ja",
  );
  assert.equal(
    preferredResponseLanguage({ languages: [" "], language: "de" }),
    "de",
  );
});

test("missing or unusable browser language falls back to English", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    });
    assert.equal(preferredResponseLanguage(), "en");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
  assert.equal(preferredResponseLanguage({}), "en");
  assert.equal(preferredResponseLanguage({ languages: [], language: "" }), "en");
  assert.equal(preferredResponseLanguage({ language: "not_a_locale" }), "en");
});

test("shared prompt prioritizes explicit requests, follow-ups, then browser language", () => {
  const prompt = systemPrompt(false, false, "es-ES");
  const explicit = prompt.indexOf("1. Follow an explicit language request");
  const question = prompt.indexOf(
    "2. Otherwise, use the language of the reader's latest follow-up question",
  );
  const browser = prompt.indexOf("3. For the initial explanation");
  assert.ok(explicit >= 0 && explicit < question && question < browser);
  assert.ok(prompt.includes("reply in French"));
  assert.ok(prompt.includes("browser language: es-ES"));
  assert.ok(
    prompt.includes(
      "first user message is note context, not a reader question or language request",
    ),
  );
  assert.ok(prompt.includes("explain an English note in Spanish"));
  assert.ok(systemPrompt(false, false).includes("browser language: en."));
});

test("updating author metadata or web search preserves language and follow-up history", () => {
  const initial = "A trending Nostr note:\nAuthor: Unknown\nNote: Hello!";
  const history = [
    { role: "system", content: systemPrompt(true, false, "es-ES") },
    { role: "user", content: initial },
    { role: "assistant", content: "An open social protocol." },
    { role: "user", content: "What is a relay?" },
  ];
  const followups = history.slice(2);
  const updated = initial.replace("Unknown", "Alice");
  assert.equal(patchNoteContextHistory(history, updated, false, "es-ES"), true);
  assert.ok(history[0].content.includes("You cannot search the web"));
  assert.ok(history[0].content.includes("browser language: es-ES"));
  assert.equal(history[1].content, updated);
  assert.deepEqual(history.slice(2), followups);
  assert.equal(patchNoteContextHistory(history, updated, false, "es-ES"), false);

  const withImage = [
    { type: "image", url: "https://example.com/photo.png" },
    { type: "text", text: updated },
  ];
  assert.equal(patchNoteContextHistory(history, withImage, true, "es-ES"), true);
  assert.equal(history[0].content, systemPrompt(true, true, "es-ES"));
  assert.deepEqual(history.slice(2), followups);
});
