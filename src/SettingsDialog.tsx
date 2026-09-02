import { useEffect, useId, useRef } from "react";
import { Avatar } from "./Avatar";
import type { Kind0Profile } from "./identity";
import { profileLabel } from "./mentions";
import {
  setFayanFilterEnabled,
  setHashtagFilterEnabled,
  setWebSearchEnabled,
  unmuteAuthor,
  useFayanFilterEnabled,
  useHashtagFilterEnabled,
  useMutedAuthors,
  useWebSearchEnabled,
} from "./settings";
import { FAYAN_MIN_PERCENTILE } from "./fayan";

const DRAWER_CLOSE_MS = 360;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SettingsDialog({
  profiles,
  onClose,
}: {
  profiles: Record<string, Kind0Profile>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const startCloseRef = useRef<() => void>(() => {});
  const closeTimerRef = useRef(0);
  const titleId = useId();
  const webSearchId = useId();
  const fayanFilterId = useId();
  const hashtagFilterId = useId();
  const mutedTitleId = useId();
  const webSearch = useWebSearchEnabled();
  const fayanFilter = useFayanFilterEnabled();
  const hashtagFilter = useHashtagFilterEnabled();
  const mutedAuthors = useMutedAuthors();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      dialog.classList.remove("is-closing");
      dialog.showModal();
    }

    const startClose = () => {
      if (!dialog.open || dialog.classList.contains("is-closing")) return;
      if (prefersReducedMotion()) {
        dialog.close();
        return;
      }
      dialog.classList.add("is-closing");
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = window.setTimeout(() => {
        if (dialog.open && dialog.classList.contains("is-closing")) {
          dialog.close();
        }
      }, DRAWER_CLOSE_MS);
    };
    startCloseRef.current = startClose;

    const handleAnimationEnd = (event: AnimationEvent) => {
      if (event.target !== dialog) return;
      if (event.animationName !== "settings-drawer-out") return;
      if (!dialog.classList.contains("is-closing")) return;
      window.clearTimeout(closeTimerRef.current);
      dialog.close();
    };

    const handleCancel = (event: Event) => {
      event.preventDefault();
      startClose();
    };

    const handleClose = () => onCloseRef.current();

    dialog.addEventListener("animationend", handleAnimationEnd);
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      window.clearTimeout(closeTimerRef.current);
      startCloseRef.current = () => {};
      dialog.removeEventListener("animationend", handleAnimationEnd);
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
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
          startCloseRef.current();
        }
      }}
    >
      <div className="settings-sheet">
        <header className="settings-header">
          <h2 id={titleId} className="settings-title">
            Settings
          </h2>
          <button
            type="button"
            className="settings-close"
            aria-label="Close"
            onClick={() => startCloseRef.current()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3.15 3.15a.5.5 0 0 1 .7 0L7 6.29l3.15-3.14a.5.5 0 1 1 .7.7L7.71 7l3.14 3.15a.5.5 0 0 1-.7.7L7 7.71l-3.15 3.14a.5.5 0 0 1-.7-.7L6.29 7 3.15 3.85a.5.5 0 0 1 0-.7"
              />
            </svg>
          </button>
        </header>

        <div className="settings-body">
          <label className="settings-row" htmlFor={webSearchId}>
            <span className="settings-row-text">
              <span className="settings-row-label">Web search for Ask AI</span>
              <span className="settings-row-hint">
                When off, the model will not search the web. This can lower
                hosted inference cost.
              </span>
            </span>
            <input
              id={webSearchId}
              className="settings-toggle"
              type="checkbox"
              checked={webSearch}
              onChange={(event) => setWebSearchEnabled(event.target.checked)}
            />
          </label>
          <label className="settings-row" htmlFor={fayanFilterId}>
            <span className="settings-row-text">
              <span className="settings-row-label">
                Filter low-reputation authors
              </span>
              <span className="settings-row-hint">
                Hide authors missing from Fayan or below the{" "}
                {FAYAN_MIN_PERCENTILE}
                th percentile. If Fayan is unavailable, the feed stays
                unfiltered.
              </span>
            </span>
            <input
              id={fayanFilterId}
              className="settings-toggle"
              type="checkbox"
              checked={fayanFilter}
              onChange={(event) => setFayanFilterEnabled(event.target.checked)}
            />
          </label>
          <label className="settings-row" htmlFor={hashtagFilterId}>
            <span className="settings-row-text">
              <span className="settings-row-label">Filter hashtag spam</span>
              <span className="settings-row-hint">
                Hide notes with 4 or more hashtag tags on the event. Spammers
                often bury these in tags without showing them in the note text.
              </span>
            </span>
            <input
              id={hashtagFilterId}
              className="settings-toggle"
              type="checkbox"
              checked={hashtagFilter}
              onChange={(event) =>
                setHashtagFilterEnabled(event.target.checked)
              }
            />
          </label>
          <section className="settings-section" aria-labelledby={mutedTitleId}>
            <h3 id={mutedTitleId} className="settings-section-title">
              Muted authors
            </h3>
            {mutedAuthors.length === 0 ? (
              <p className="settings-section-empty">No muted authors.</p>
            ) : (
              <ul className="settings-muted-list">
                {mutedAuthors.map((pubkey) => (
                  <li key={pubkey} className="settings-muted-item">
                    <span className="settings-muted-author">
                      <Avatar src={profiles[pubkey]?.picture} />
                      <span className="settings-muted-name">
                        {profileLabel(pubkey, profiles[pubkey]?.displayName)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="settings-muted-unmute"
                      onClick={() => unmuteAuthor(pubkey)}
                    >
                      Unmute
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}
