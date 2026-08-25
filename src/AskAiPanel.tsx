import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  completeChat,
  describeInferenceError,
  isAbortError,
  type ChatStatus,
  type InferenceMessage,
} from "./inference";
import { encodeNpub, type Kind0Profile } from "./identity";
import { njumpHref, profileLabel } from "./mentions";
import { AskAiMarkdown } from "./AskAiMarkdown";
import { encodeNevent } from "./nostr-clients";
import {
  formatCreateAtDate,
  type LocatedEvent,
  type NoteEngagement,
} from "./nostr";

const MAX_NOTE_CHARS = 8000;

type VisibleMessage =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      pending?: boolean;
      status?: ChatStatus;
    }
  | { id: string; role: "error"; content: string };

type Thread = {
  history: InferenceMessage[];
  visible: VisibleMessage[];
  introStarted: boolean;
};

const threads = new Map<string, Thread>();

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `ask-${messageSeq}`;
}

function emptyThread(): Thread {
  return { history: [], visible: [], introStarted: false };
}

function getThread(noteId: string): Thread {
  const existing = threads.get(noteId);
  if (existing) return existing;
  const created = emptyThread();
  threads.set(noteId, created);
  return created;
}

function snapshot(thread: Thread): Thread {
  return {
    history: [...thread.history],
    visible: [...thread.visible],
    introStarted: thread.introStarted,
  };
}

function systemPrompt(): string {
  return [
    "You help someone read a public Nostr note from a trending feed.",
    "The reader can already see the note. There are no replies in this app, so do not summarize the text back to them.",
    "On the first reply, explain and check:",
    "- What is this referring to, and who or what is involved?",
    "- If it makes a claim or shares news, is that actually true? Search if you need to.",
    "- If it is jargon, a meme, or an in-joke, explain it.",
    "- If it asks a question, answer it.",
    "- If it is a simple status or joke, say so in one line and stop.",
    "You can search the public web when that would help: checking a claim, identifying a person or project, current events, or facts that are not in the note. Do not search when the note itself is enough. If you searched, say so briefly.",
    "Keep answers short. Light markdown is fine: bold, short lists, and links. Do not use headings or code fences.",
    "You are not the note's author. If you are unsure, say so. Invite a follow-up when it would help.",
  ].join("\n");
}

function formatEngagement(stats?: NoteEngagement): string {
  if (!stats) return "unknown";
  return [
    `${stats.replies.toLocaleString()} replies`,
    `${stats.zapAmount.toLocaleString()} sats`,
    `${stats.reactions.toLocaleString()} reactions`,
    `${stats.reposts.toLocaleString()} reposts`,
  ].join(", ");
}

const NOTE_CONTEXT_INSTRUCTION =
  "Explain this note and check whether its claims hold up. Search the web if that would help. Do not summarize the note.";

function buildNoteContext(
  note: LocatedEvent,
  authorName: string,
  stats?: NoteEngagement
): string {
  const npub = encodeNpub(note.pubkey);
  let nevent = "";
  try {
    nevent = encodeNevent(note);
  } catch {
    /* ignore */
  }
  const raw = note.content.trim() || "(no text — media-only note)";
  const truncated =
    raw.length > MAX_NOTE_CHARS
      ? `${raw.slice(0, MAX_NOTE_CHARS)}\n\n[note truncated]`
      : raw;

  return [
    "A trending Nostr note:",
    `Author: ${authorName}${npub ? ` (${npub})` : ""}`,
    `Posted: ${formatCreateAtDate(note.created_at)}`,
    `Engagement: ${formatEngagement(stats)}`,
    nevent ? `Link: ${njumpHref(nevent)}` : `Note id: ${note.id}`,
    "",
    "Note:",
    truncated,
  ].join("\n");
}

function noteContextUserContent(
  note: LocatedEvent,
  authorName: string,
  stats?: NoteEngagement
): string {
  return `${buildNoteContext(note, authorName, stats)}\n\n${NOTE_CONTEXT_INSTRUCTION}`;
}

function patchNoteContextHistory(
  history: InferenceMessage[],
  content: string
): boolean {
  const context = history[1];
  if (history[0]?.role !== "system" || context?.role !== "user") return false;
  if (context.content === content) return false;
  history[1] = { role: "user", content };
  return true;
}

function SparkleIcon() {
  return (
    <svg className="ask-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3l1.6 5.1L19 9.7l-5.4 1.6L12 16.5l-1.6-5.2L5 9.7l5.4-1.6L12 3zm6.5 9.5l.9 2.8 2.8.9-2.8.9-.9 2.8-.9-2.8-2.8-.9 2.8-.9.9-2.8zM5.5 14l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1z"
      />
    </svg>
  );
}

export function AskAiButton({
  pressed,
  onClick,
}: {
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ask-ai-btn"
      aria-pressed={pressed}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <SparkleIcon />
      Ask AI
    </button>
  );
}

function statusLabel(status: ChatStatus): string {
  if (status === "thinking") return "Thinking";
  if (status === "generating") return "Generating";
  return "Waiting";
}

export function AskAiPanel({
  note,
  profile,
  engagement,
  onClose,
}: {
  note: LocatedEvent;
  profile?: Kind0Profile;
  engagement?: NoteEngagement;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const noteIdRef = useRef(note.id);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  noteIdRef.current = note.id;

  const titleId = useId();
  const authorName = profileLabel(note.pubkey, profile?.displayName);

  const [thread, setThread] = useState<Thread>(() => snapshot(getThread(note.id)));
  const [draft, setDraft] = useState("");
  const busy = thread.visible.some(
    (message) => message.role === "assistant" && message.pending
  );

  function persist(noteId: string, next: Thread) {
    threads.set(noteId, next);
    if (noteIdRef.current === noteId) {
      setThread(snapshot(next));
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();

    const handleClose = () => {
      abortRef.current?.abort();
      onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    setThread(snapshot(getThread(note.id)));
    setDraft("");
  }, [note.id]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [thread.visible]);

  useEffect(() => {
    if (busy) return;
    inputRef.current?.focus();
  }, [busy, note.id]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`;
  }, [draft]);

  async function runTurn(userText: string | null) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const noteId = note.id;
    const contextContent = noteContextUserContent(note, authorName, engagement);

    const current = getThread(noteId);
    if (current.history.length === 0) {
      current.history = [
        { role: "system", content: systemPrompt() },
        { role: "user", content: contextContent },
      ];
    } else {
      patchNoteContextHistory(current.history, contextContent);
    }

    let userVisibleId: string | undefined;
    if (userText) {
      userVisibleId = nextId();
      current.history.push({ role: "user", content: userText });
      current.visible.push({
        id: userVisibleId,
        role: "user",
        content: userText,
      });
    }

    const assistantId = nextId();
    current.visible.push({
      id: assistantId,
      role: "assistant",
      content: "",
      pending: true,
      status: "waiting",
    });
    current.introStarted = true;
    persist(noteId, current);

    const patchAssistant = (patch: Partial<Extract<VisibleMessage, { role: "assistant" }>>) => {
      const live = getThread(noteId);
      live.visible = live.visible.map((message) =>
        message.id === assistantId && message.role === "assistant"
          ? { ...message, ...patch }
          : message
      );
      persist(noteId, live);
    };

    const settleAborted = () => {
      const live = getThread(noteId);
      const last = live.visible.find(
        (message) => message.id === assistantId && message.role === "assistant"
      );
      if (last?.role === "assistant") {
        if (!last.content) {
          live.visible = live.visible.filter(
            (message) =>
              message.id !== assistantId && message.id !== userVisibleId
          );
          if (userText && live.history.at(-1)?.role === "user") {
            live.history.pop();
          }
          if (!live.visible.some((message) => message.role === "assistant")) {
            live.introStarted = false;
            live.history = [];
          }
          if (noteIdRef.current === noteId && userText) {
            setDraft(userText);
          }
        } else {
          live.visible = live.visible.map((message) =>
            message.id === assistantId && message.role === "assistant"
              ? { ...message, pending: false }
              : message
          );
          if (live.history.at(-1)?.role !== "assistant") {
            live.history.push({ role: "assistant", content: last.content });
          }
        }
      }
      persist(noteId, live);
    };

    try {
      const result = await completeChat({
        messages: current.history.map((message) => ({ ...message })),
        signal: controller.signal,
        onStatus(status) {
          patchAssistant({ status });
        },
        onDelta(text) {
          patchAssistant({ content: text });
        },
      });

      if (controller.signal.aborted) {
        settleAborted();
        return;
      }

      const live = getThread(noteId);
      const content = result.content;
      if (!content) {
        live.visible = live.visible.filter((message) => message.id !== assistantId);
        live.visible.push({
          id: nextId(),
          role: "error",
          content: "The model returned an empty reply.",
        });
      } else {
        live.history.push({ role: "assistant", content });
        live.visible = live.visible.map((message) =>
          message.id === assistantId && message.role === "assistant"
            ? { ...message, content, pending: false }
            : message
        );
      }
      persist(noteId, live);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        settleAborted();
        return;
      }

      const live = getThread(noteId);
      const errorText = describeInferenceError(error);

      if (userText && live.history.at(-1)?.role === "user") {
        live.history.pop();
      }
      live.visible = live.visible.filter((message) => message.id !== assistantId);
      live.visible.push({
        id: nextId(),
        role: "error",
        content: errorText,
      });
      if (!live.visible.some((message) => message.role === "assistant")) {
        live.introStarted = false;
      }
      persist(noteId, live);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;

  useEffect(() => {
    const current = getThread(note.id);
    if (current.introStarted || current.visible.length > 0) return;
    current.introStarted = true;
    threads.set(note.id, current);
    void runTurnRef.current(null);
    return () => {
      abortRef.current?.abort();
    };
  }, [note.id]);

  useEffect(() => {
    const current = getThread(note.id);
    const nextContent = noteContextUserContent(note, authorName, engagement);
    if (!patchNoteContextHistory(current.history, nextContent)) return;

    const restartingIntro = current.visible.some(
      (message) =>
        message.role === "assistant" && message.pending && !message.content
    );
    if (restartingIntro) {
      current.visible = current.visible.filter(
        (message) =>
          !(
            message.role === "assistant" &&
            message.pending &&
            !message.content
          )
      );
    }
    persist(note.id, current);
    if (restartingIntro) {
      void runTurnRef.current(null);
    }
  }, [note, authorName, engagement]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    void runTurn(content);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleClear() {
    if (busy) return;
    abortRef.current?.abort();
    abortRef.current = null;
    const fresh = emptyThread();
    threads.set(note.id, fresh);
    setThread(fresh);
    void runTurn(null);
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  const snippet = note.content.trim().replace(/\s+/g, " ");

  return (
    <dialog
      ref={dialogRef}
      className="ask-ai-dialog"
      aria-labelledby={titleId}
      onClick={(event) => {
        const dialog = event.currentTarget;
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          dialog.close();
        }
      }}
    >
      <div className="ask-ai-sheet">
        <header className="ask-ai-header">
          <div className="ask-ai-heading">
            <h2 id={titleId}>
              Ask AI
              <span>May search the web</span>
            </h2>
            <p className="ask-ai-about">
              About {authorName}
              {snippet ? ` · ${snippet}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="ask-ai-icon-btn"
            aria-label="Close"
            onClick={() => dialogRef.current?.close()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3.15 3.15a.5.5 0 0 1 .7 0L7 6.29l3.15-3.14a.5.5 0 1 1 .7.7L7.71 7l3.14 3.15a.5.5 0 0 1-.7.7L7 7.71l-3.15 3.14a.5.5 0 0 1-.7-.7L6.29 7 3.15 3.85a.5.5 0 0 1 0-.7"
              />
            </svg>
          </button>
        </header>

        <div ref={logRef} className="ask-ai-log" aria-live="polite">
          {thread.visible.map((message) => {
            if (message.role === "error") {
              return (
                <div key={message.id} className="ask-ai-msg error">
                  {message.content}
                </div>
              );
            }
            if (message.role === "user") {
              return (
                <div key={message.id} className="ask-ai-msg user">
                  <span className="ask-ai-msg-label">You</span>
                  {message.content}
                </div>
              );
            }
            const waiting = Boolean(message.pending && !message.content);
            return (
              <div
                key={message.id}
                className={`ask-ai-msg assistant${waiting ? " pending" : ""}`}
              >
                <span className="ask-ai-msg-label">Assistant</span>
                {waiting ? (
                  <span
                    className="ask-ai-typing"
                    aria-label={`${statusLabel(message.status ?? "waiting")} for response`}
                  >
                    <span className="ask-ai-typing-label">
                      {statusLabel(message.status ?? "waiting")}
                    </span>
                    <span className="ask-ai-typing-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                ) : null}
                {message.content ? (
                  <div className="ask-ai-msg-body">
                    <AskAiMarkdown>{message.content}</AskAiMarkdown>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <form className="ask-ai-form" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Ask a follow-up…"
            autoComplete="off"
            enterKeyHint="send"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <div className="ask-ai-actions">
            <button
              type="button"
              className="ask-ai-secondary"
              disabled={
                busy ||
                (thread.introStarted && thread.visible.length === 0 && !draft)
              }
              onClick={handleClear}
            >
              Clear
            </button>
            {busy ? (
              <button
                type="button"
                className="ask-ai-secondary"
                onClick={handleStop}
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="ask-ai-send"
                disabled={!draft.trim()}
              >
                Ask
              </button>
            )}
          </div>
        </form>
      </div>
    </dialog>
  );
}
