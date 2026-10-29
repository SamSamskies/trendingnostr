const OPAQUE_PROVIDER_LOAD_HINT =
  "Retry in a moment or pick another model — busy or free-tier models often fail this way.";
const OPAQUE_PROVIDER_TOOL_HINT =
  "The model's web search or other hosted tool failed — retry, pick another model, or turn off web search.";

/** Opaque gateway wrappers; the useful reason is often missing. */
export function withOpaqueProviderHint(message: string): string {
  const trimmed = message.trim();
  const key = trimmed.toLowerCase();
  if (key === "provider returned error") {
    return `${trimmed}. ${OPAQUE_PROVIDER_LOAD_HINT}`;
  }
  if (key === "server tool request failed") {
    return `${trimmed}. ${OPAQUE_PROVIDER_TOOL_HINT}`;
  }
  return message;
}
