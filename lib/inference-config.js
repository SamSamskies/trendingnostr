/** Backend-owned models for the supported shared providers. */
export const SHARED_DEFAULT_MODELS = {
  ollama: "gemma4:cloud", gemini: "gemma-4-31b-it", replit: "google/gemma-4-26b-a4b-it",
};

export function sharedProviderId() {
  return process.env.SHARED_INFERENCE_PROVIDER?.trim().toLowerCase() || "";
}

export function sharedModelId() {
  const provider = sharedProviderId();
  const setting = { ollama: "OLLAMA_INFERENCE_MODEL", gemini: "GEMINI_MODEL", replit: "REPLIT_INFERENCE_MODEL" }[provider];
  return (setting && process.env[setting]?.trim()) || SHARED_DEFAULT_MODELS[provider];
}

export function fallbackDisabled() {
  const flag = (process.env.INFERENCE_FALLBACK_ENABLED ?? "").trim().toLowerCase();
  return ["0", "false", "off"].includes(flag);
}
