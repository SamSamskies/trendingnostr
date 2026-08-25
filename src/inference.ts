import { useSyncExternalStore } from "react";

export type InferenceRole = "system" | "user" | "assistant";

export type InferenceMessage = {
  role: InferenceRole;
  content: string;
};

export type InferenceErrorCode =
  | "permission_denied"
  | "invalid_request"
  | "unavailable"
  | "provider_error"
  | "aborted";

export type InferenceError = Error & {
  code: InferenceErrorCode;
};

type InferenceRequest = {
  method: "chat";
  messages: InferenceMessage[];
  tools?: Array<{ type: "web_search" }>;
  signal?: AbortSignal;
};

type InferenceChunk =
  | { type: "accepted" }
  | { type: "reasoning_delta"; content: string }
  | { type: "delta"; content: string }
  | {
      type: "done";
      model: string;
      message: { role: "assistant"; content: string | null };
    };

type InferenceRequestFn = (request: InferenceRequest) => AsyncIterable<InferenceChunk>;

type Inference = {
  request: InferenceRequestFn;
  experimental?: {
    request?: InferenceRequestFn;
  };
};

export type ChatStatus = "waiting" | "generating" | "thinking";

export type ChatResult = {
  content: string;
  model?: string;
};

const WEB_SEARCH_TOOL = { type: "web_search" } as const;
const DETECT_FAST_MS = 8000;
const DETECT_FAST_INTERVAL_MS = 50;

declare global {
  interface Window {
    inference?: Inference;
  }
}

function lookupInference(): Inference | undefined {
  const inference = window.inference;
  if (inference == null || typeof inference.request !== "function") {
    return undefined;
  }
  return inference;
}

export function isInferenceAvailable(): boolean {
  return lookupInference() != null;
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

function chatRequest(inference: Inference): {
  request: InferenceRequestFn;
  tools?: Array<{ type: "web_search" }>;
} {
  const experimentalRequest = inference.experimental?.request;
  if (typeof experimentalRequest === "function") {
    return {
      request: experimentalRequest.bind(inference.experimental),
      tools: [WEB_SEARCH_TOOL],
    };
  }
  return { request: inference.request.bind(inference) };
}

export function isInferenceError(error: unknown): error is InferenceError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as InferenceError).code === "string"
  );
}

export function isAbortError(error: unknown): boolean {
  if (isInferenceError(error) && error.code === "aborted") return true;
  return error instanceof DOMException && error.name === "AbortError";
}

export function describeInferenceError(error: unknown): string {
  if (isAbortError(error)) return "Stopped.";
  if (isInferenceError(error)) {
    if (error.code === "permission_denied") {
      return "Inference was denied for this site.";
    }
    if (error.code === "unavailable") {
      return "Inference is unavailable. Check the extension and try again.";
    }
    if (error.code === "invalid_request") {
      return error.message || "The inference request was rejected.";
    }
    return error.message || "The inference provider failed.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Inference failed.";
}

async function consumeChat(
  request: InferenceRequestFn,
  payload: InferenceRequest,
  onStatus?: (status: ChatStatus) => void,
  onDelta?: (text: string) => void
): Promise<{ content: string; model?: string }> {
  let text = "";
  let model: string | undefined;
  let sawDelta = false;

  for await (const chunk of request(payload)) {
    if (chunk.type === "accepted") {
      onStatus?.("generating");
    } else if (chunk.type === "reasoning_delta") {
      onStatus?.("thinking");
    } else if (chunk.type === "delta") {
      sawDelta = true;
      text += chunk.content;
      onDelta?.(text);
    } else if (chunk.type === "done") {
      const content = chunk.message?.content;
      if (typeof content === "string" && (content.length > 0 || !sawDelta)) {
        text = content;
      }
      model = chunk.model;
      onDelta?.(text);
    }
  }

  return { content: text, model };
}

export async function completeChat(options: {
  messages: InferenceMessage[];
  signal?: AbortSignal;
  onStatus?: (status: ChatStatus) => void;
  onDelta?: (text: string) => void;
}): Promise<ChatResult> {
  const inference = lookupInference();
  if (!inference) {
    const error = new Error(
      "window.inference is not available."
    ) as InferenceError;
    error.code = "unavailable";
    throw error;
  }

  const { request, tools } = chatRequest(inference);

  return consumeChat(
    request,
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
