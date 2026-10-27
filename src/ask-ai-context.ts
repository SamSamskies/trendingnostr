import type { ContentPart } from "ipa-tools";
import type { InferenceMessage } from "./inference";

export function preferredResponseLanguage(
  browser: Partial<Pick<Navigator, "languages" | "language">> | undefined =
    typeof navigator === "undefined" ? undefined : navigator,
): string {
  for (const language of [...(browser?.languages ?? []), browser?.language]) {
    if (!language?.trim()) continue;
    try {
      const [locale] = Intl.getCanonicalLocales(language.trim());
      if (locale) return locale;
    } catch {
      // Ignore unusable language tags and try the next browser preference.
    }
  }
  return "en";
}

export function systemPrompt(
  canSearch: boolean,
  hasImages: boolean,
  responseLanguage = "en"
): string {
  return [
    "You help someone read a public Nostr note from a trending feed.",
    "The reader can already see the note. There are no replies in this app, so do not summarize the text back to them.",
    "Choose the response language in this priority order:",
    "1. Follow an explicit language request from the reader, including an earlier request that still applies (for example, 'reply in French').",
    "2. Otherwise, use the language of the reader's latest follow-up question.",
    `3. For the initial explanation, or when there is no stronger signal, use the reader's browser language: ${responseLanguage}.`,
    "The first user message is note context, not a reader question or language request. The note's language and the English context labels do not determine the response language. For example, explain an English note in Spanish when the browser language is Spanish.",
    hasImages
      ? "The first user message includes the note's images before the text. Look at those images when they matter."
      : null,
    "On the first reply, explain and check:",
    "- What is this referring to, and who or what is involved?",
    canSearch
      ? "- If it makes a claim or shares news, is that actually true? Search if you need to."
      : "- If it makes a claim or shares news, is that actually true? Say so if you cannot verify it.",
    "- If it is jargon, a meme, or an in-joke, explain it.",
    "- If it asks a question, answer it.",
    "- If it is a simple status or joke, say so in one line and stop.",
    canSearch
      ? "You can search the public web when that would help: checking a claim, identifying a person or project, current events, or facts that are not in the note. Do not search when the note itself is enough. If you searched, say so briefly."
      : "You cannot search the web. Do not claim you searched. If a claim needs verification you cannot do, say so.",
    "Keep answers short. Light markdown is fine: bold, short lists, and links. Do not use headings or code fences.",
    "You are not the note's author. If you are unsure, say so. Invite a follow-up when it would help.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function patchNoteContextHistory(
  history: InferenceMessage[],
  content: string | ContentPart[],
  canSearch: boolean,
  responseLanguage = "en"
): boolean {
  const system = history[0];
  const context = history[1];
  if (system?.role !== "system" || context?.role !== "user") return false;
  const nextSystem = systemPrompt(
    canSearch,
    Array.isArray(content),
    responseLanguage
  );
  const contentSame = JSON.stringify(context.content) === JSON.stringify(content);
  const systemSame = system.content === nextSystem;
  if (contentSame && systemSame) return false;
  history[0] = { role: "system", content: nextSystem };
  history[1] = { role: "user", content };
  return true;
}

