import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPromptDateTime,
  patchNoteContextHistory,
  preferredResponseLanguage,
  systemPrompt,
} from "../src/ask-ai-context.ts";
import { noteImageUrls } from "../src/media.ts";

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

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

test("prompt timestamps are local ISO-8601 with a numeric offset", () => {
  const date = new Date("2026-10-29T13:02:45.500Z");
  const second = formatPromptDateTime(date);
  const minute = formatPromptDateTime(date, "minute");
  assert.match(second, ISO_OFFSET);
  assert.match(minute, ISO_OFFSET);
  assert.equal(Math.floor(Date.parse(second) / 1000), Math.floor(date.getTime() / 1000));
  assert.equal(Math.floor(Date.parse(minute) / 60_000), Math.floor(date.getTime() / 60_000));
  assert.ok(minute.endsWith(":00" + minute.slice(-6)));
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const expectedZone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  assert.ok(second.endsWith(expectedZone));
  assert.ok(minute.endsWith(expectedZone));
});

test("shared prompt includes the current time and prioritizes language signals", () => {
  const now = new Date("2026-10-29T13:02:45Z");
  const prompt = systemPrompt(false, false, "es-ES", now);
  assert.ok(
    prompt.includes(
      `The current date and time is ${formatPromptDateTime(now, "minute")}.`,
    ),
  );
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
  const now = new Date("2026-10-29T13:02:00Z");
  const initial = "A trending Nostr note:\nAuthor: Unknown\nNote: Hello!";
  const history = [
    { role: "system", content: systemPrompt(true, false, "es-ES", now) },
    { role: "user", content: initial },
    { role: "assistant", content: "An open social protocol." },
    { role: "user", content: "What is a relay?" },
  ];
  const followups = history.slice(2);
  const updated = initial.replace("Unknown", "Alice");
  assert.equal(patchNoteContextHistory(history, updated, false, "es-ES", now), true);
  assert.ok(history[0].content.includes("You cannot search the web"));
  assert.ok(history[0].content.includes("browser language: es-ES"));
  assert.equal(history[1].content, updated);
  assert.deepEqual(history.slice(2), followups);
  assert.equal(patchNoteContextHistory(history, updated, false, "es-ES", now), false);

  const withImage = [
    { type: "image", url: "https://example.com/photo.png" },
    { type: "text", text: updated },
  ];
  assert.equal(patchNoteContextHistory(history, withImage, true, "es-ES", now), true);
  assert.equal(history[0].content, systemPrompt(true, true, "es-ES", now));
  assert.deepEqual(history.slice(2), followups);
});

test("note images dedupe the same Blossom blob across different hosts", () => {
  const hash = "ab".repeat(32);
  const inlineBlossom = `https://cdn.example/${hash}.png`;
  const imetaBlossom = `https://blossom.example/${hash}`;
  assert.deepEqual(
    noteImageUrls(inlineBlossom, [
      ["imeta", `url ${imetaBlossom}`, "m image/png"],
    ]),
    [inlineBlossom],
  );
});

test("a newer clock refreshes the system prompt without looking like the note changed", () => {
  const earlier = new Date("2026-10-29T13:02:00Z");
  const later = new Date("2026-10-29T14:15:00Z");
  const note = "A trending Nostr note:\nAuthor: Alice\nNote: Hello!";
  const history = [
    { role: "system", content: systemPrompt(true, false, "es-ES", earlier) },
    { role: "user", content: note },
  ];
  assert.equal(patchNoteContextHistory(history, note, true, "es-ES", later), false);
  assert.equal(history[0].content, systemPrompt(true, false, "es-ES", later));
  assert.equal(history[1].content, note);
});
