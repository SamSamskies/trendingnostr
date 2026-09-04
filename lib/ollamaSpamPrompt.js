/**
 * Shared spam-classify prompt + cheap prefilters (Mac Mini Ollama path).
 */

export const SPAM_CLASSIFY_SYSTEM = `You classify Nostr kind-1 notes for a public trending feed.

Return ONLY a JSON object with this shape:
{
  "spam": boolean,
  "confidence": number,
  "category": string,
  "reason": string
}

Be conservative. When unsure, mark spam:false.

Mark spam:true ONLY when the note itself is clearly:
- a trading/crypto sales funnel (VIP/Telegram signals, paid mentorship, "join my group", fake win-rate flex with CTA), OR
- a machine/protocol payload posted as kind 1 (zone_presence / constitute heartbeats, raw JSON telemetry), OR
- an explicit scam/affiliate pitch with a call to action

Mark spam:false for almost everything else, including:
- news headlines, politics, sensational wording, "clickbait" tone
- jokes, memes, opinions, adult content, fundraising appeals without a trading-signal funnel
- short reactions / quote-replies (emoji + nostr:nevent/note)
- market talk or personal trade journaling without a sales CTA
- warnings about scams, or posts that merely discuss spam

Do NOT treat PoW/nonce tags, client tags, nostr: URIs, emoji, or hypey headlines as spam by themselves.

confidence is 0..1. category is a short snake_case label. reason is one short sentence.`;

/** Categories we will never auto-drop on, even if the model says spam. */
export const SPAM_CATEGORY_BLOCKLIST = new Set([
  "clickbait",
  "clickbait_scam",
  "clickbait_scareware",
  "engagement_bait",
  "news_headline",
  "hype_scam",
  "adult_content_link",
  "spam_removal_claim",
  "crypto_scam_warning",
]);

/**
 * True when content is basically emoji / whitespace / nostr entity refs.
 * These are common quote-replies and should not be LLM-flagged as spam.
 */
export function isTrivialSocialNote(content) {
  if (typeof content !== "string") return true;
  const stripped = content
    .replace(/nostr:(?:note|nevent|naddr|nprofile|npub)1[a-z0-9]+/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
  return stripped.length <= 8;
}

/**
 * Extra gate so the model cannot hide notes on "vibes" alone.
 * Require a concrete funnel / payload signal in the text.
 */
export function hasSpamCorroboration(content) {
  if (typeof content !== "string" || !content.trim()) return false;
  const c = content.toLowerCase();

  if (
    /zone[_\s-]?presence/.test(c) ||
    /\bconstitute\b/.test(c) ||
    /^\s*[{\[]/.test(content.trim())
  ) {
    return true;
  }

  if (
    /\bt\.me\/|\btelegram\b|\bwhatsapp\b/.test(c) ||
    /\bjoin\s+(my\s+)?(vip|group|channel)\b/.test(c) ||
    /\bvip\s+signals?\b|\bsignal\s+group\b/.test(c) ||
    /\bdm\s+me\b.*\b(mentor|signal|trade|vip)\b/.test(c) ||
    /\b(paid|premium)\s+(signals?|group|mentorship)\b/.test(c) ||
    /\b\d{1,3}%\s+win\s*rate\b/.test(c)
  ) {
    return true;
  }

  return false;
}

/**
 * Final drop decision after the model reply.
 */
export function shouldDropAsSpam(prediction, content, confidenceThreshold) {
  if (!prediction || !prediction.spam) return false;
  if (prediction.confidence < confidenceThreshold) return false;
  const category = (prediction.category || "").toLowerCase();
  if (SPAM_CATEGORY_BLOCKLIST.has(category)) return false;
  if (!hasSpamCorroboration(content)) return false;
  return true;
}
