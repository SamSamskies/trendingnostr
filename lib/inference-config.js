/** Backend-owned defaults shared by the proxy and retained direct route. */
export const DEFAULT_MODELS = { ollama: "gemma4:cloud", gemini: "gemma-4-31b-it" };

export function providerId() {
  return process.env.INFERENCE_PROVIDER?.trim().toLowerCase() || "ollama";
}

export function modelId() {
  const provider = providerId();
  return process.env[provider === "ollama" ? "OLLAMA_INFERENCE_MODEL" : "GEMINI_MODEL"]?.trim() ||
    (process.env.INFERENCE_PROVIDER?.trim() ? process.env.INFERENCE_MODEL?.trim() : "") ||
    DEFAULT_MODELS[provider];
}

export function fallbackDisabled() {
  const flag = (
    process.env.INFERENCE_FALLBACK_ENABLED ??
    (providerId() === "gemini" ? process.env.GEMINI_FALLBACK_ENABLED : undefined) ??
    ""
  ).trim().toLowerCase();
  return ["0", "false", "off"].includes(flag);
}
