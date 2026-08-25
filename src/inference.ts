import { useSyncExternalStore } from "react";
import {
  createInference,
  getFeatures,
  isInferenceAvailable,
  isInferenceError,
  type Inference,
  type InferenceRequest,
} from "ipa-tools";
import {
  createHostedBackend,
  hasHostedConsent,
  HOSTED_BACKEND_ID,
  setHostedConsent,
} from "./hosted-backend";

export type InferenceMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatStatus = "waiting" | "generating" | "thinking";

export type ChatResult = {
  content: string;
  model?: string;
};

export type InferenceGate = "ipa" | "hosted" | "consent" | "unavailable";

export { hasHostedConsent, setHostedConsent };

export const INFERENCE_BRIDGE_HREF =
  "https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd";

const WEB_SEARCH_TOOL = { type: "web_search" } as const;
const DETECT_FAST_MS = 8000;
const DETECT_FAST_INTERVAL_MS = 50;

type InferenceWithExperimental = Inference & {
  experimental?: { request?: Inference["request"] };
};

type StreamChunk = {
  type: string;
  content?: string;
  model?: string;
  message?: { role?: string; content?: string | null };
};

const hostedBackend = createHostedBackend();
const inferenceClient = createInference({
  fallbacks: [hostedBackend],
});

function lookupInference(): InferenceWithExperimental | undefined {
  const inference = window.inference as InferenceWithExperimental | undefined;
  if (inference == null || typeof inference.request !== "function") {
    return undefined;
  }
  return inference;
}

export function isSupportedContext(): boolean {
  return window.isSecureContext && location.origin !== "null";
}

function subscribeInference(onStoreChange: () => void): () => void {
  const started = Date.now();
  const timer = window.setInterval(() => {
    onStoreChange();
    if (isInferenceAvailable() || Date.now() - started > DETECT_FAST_MS) {
      window.clearInterval(timer);
    }
  }, DETECT_FAST_INTERVAL_MS);
  window.addEventListener("focus", onStoreChange);
  document.addEventListener("visibilitychange", onStoreChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onStoreChange);
    document.removeEventListener("visibilitychange", onStoreChange);
  };
}

export function useInferenceAvailable(): boolean {
  return useSyncExternalStore(
    subscribeInference,
    isInferenceAvailable,
    () => false
  );
}

function inferenceFeatures() {
  try {
    return getFeatures();
  } catch {
    return {};
  }
}

export function canSearchWeb(): boolean {
  if (isInferenceAvailable()) {
    if (inferenceFeatures().webSearch) return true;
    return typeof lookupInference()?.experimental?.request === "function";
  }
  // Hosted Gemini/Gemma grounding uses Google Search when IPA is absent.
  return true;
}

export async function prepareInference(): Promise<InferenceGate> {
  if (!isSupportedContext()) return "unavailable";
  if (isInferenceAvailable()) return "ipa";
  try {
    const status = await inferenceClient.probe();
    if (status.ipa === "available") return "ipa";
    if (status[HOSTED_BACKEND_ID] === "available") {
      return hasHostedConsent() ? "hosted" : "consent";
    }
  } catch {
    // probe failures mean hosted is unavailable
  }
  return "unavailable";
}

export function isAbortError(error: unknown): boolean {
  if (isInferenceError(error) && error.code === "aborted") return true;
  const code = errorCodeOf(error);
  if (code === "aborted" || code === "aborted") return true;
  return error instanceof DOMException && error.name === "AbortError";
}

function errorCodeOf(error: unknown): string | undefined {
  if (isInferenceError(error)) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function describeInferenceError(error: unknown): string {
  if (isAbortError(error)) return "Stopped.";
  const code = errorCodeOf(error);
  const message =
    error instanceof Error && error.message ? error.message : "";

  if (code === "permission_denied" || code === "permission_denied") {
    return "Inference was denied for this site.";
  }
  if (code === "unavailable") {
    if (/client_limit/i.test(message)) {
      return "This browser has used today's hosted inference allowance.";
    }
    if (/rate_limited/i.test(message)) {
      return "Too many hosted requests. Wait a moment and try again.";
    }
    if (/quota_exhausted/i.test(message)) {
      return "Hosted inference is out of quota today. Try Inference Bridge, or try again tomorrow.";
    }
    return (
      message ||
      "Inference is unavailable. Check the extension and try again."
    );
  }
  if (code === "invalid_request" || code === "invalid_request") {
    return message || "The inference request was rejected.";
  }
  if (code === "provider_error" || code === "provider_error") {
    return message || "The inference provider failed.";
  }
  if (message) return message;
  return "Inference failed.";
}

function chunkModel(chunk: StreamChunk): string | undefined {
  if (typeof chunk.model === "string" && chunk.model) return chunk.model;
  const legacy = (chunk as { model?: unknown }).model;
  return typeof legacy === "string" && legacy ? legacy : undefined;
}

async function consumeChat(
  request: (payload: InferenceRequest) => AsyncIterable<unknown>,
  payload: InferenceRequest,
  onStatus?: (status: ChatStatus) => void,
  onDelta?: (text: string) => void
): Promise<ChatResult> {
  let text = "";
  let model: string | undefined;
  let sawDelta = false;

  for await (const raw of request(payload)) {
    const chunk = raw as StreamChunk;
    if (chunk.type === "accepted" || chunk.type === "accepted") {
      onStatus?.("generating");
    } else if (
      chunk.type === "reasoning_delta" ||
      chunk.type === "reasoning_delta"
    ) {
      onStatus?.("thinking");
    } else if (chunk.type === "delta" || chunk.type === "delta") {
      sawDelta = true;
      text += chunk.content ?? "";
      onDelta?.(text);
    } else if (chunk.type === "done") {
      const content = chunk.message?.content;
      if (typeof content === "string" && (content.length > 0 || !sawDelta)) {
        text = content;
      }
      model = chunkModel(chunk) ?? model;
      onDelta?.(text);
    }
  }

  return { content: text, model };
}

function experimentalWebSearchRequest(
  inference: InferenceWithExperimental
): Inference["request"] | undefined {
  const experimental = inference.experimental?.request;
  if (typeof experimental !== "function") return undefined;
  if (inferenceFeatures().webSearch) return undefined;
  return experimental.bind(inference.experimental);
}

export async function completeChat(options: {
  messages: InferenceMessage[];
  signal?: AbortSignal;
  onStatus?: (status: ChatStatus) => void;
  onDelta?: (text: string) => void;
}): Promise<ChatResult> {
  const inference = lookupInference();
  const experimentalRequest = inference
    ? experimentalWebSearchRequest(inference)
    : undefined;

  if (experimentalRequest) {
    return consumeChat(
      experimentalRequest,
      {
        method: "chat",
        messages: options.messages,
        tools: [WEB_SEARCH_TOOL],
        signal: options.signal,
      },
      options.onStatus,
      options.onDelta
    );
  }

  const tools = inferenceFeatures().webSearch
    ? [WEB_SEARCH_TOOL]
    : undefined;

  return consumeChat(
    (payload) => inferenceClient.request(payload),
    {
      method: "chat",
      messages: options.messages,
      ...(tools ? { tools } : {}),
      signal: options.signal,
    },
    options.onStatus,
    options.onDelta
  );
}
