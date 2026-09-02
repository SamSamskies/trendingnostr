import { useEffect, useId, useRef } from "react";
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

export function SettingsDialog({
  profiles,
  onClose,
}: {
  profiles: Record<string, Kind0Profile>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
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
    if (!dialog.open) dialog.showModal();

    const handleClose = () => onCloseRef.current();
    dialog.addEventListener("close", handleClose);
    return () => {
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
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <h2 id={titleId} className="settings-title">
        Settings
      </h2>
      <label className="settings-row" htmlFor={webSearchId}>
        <span className="settings-row-text">
          <span className="settings-row-label">Web search for Ask AI</span>
          <span className="settings-row-hint">
            When off, the model will not search the web. This can lower hosted
            inference cost.
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
          <span className="settings-row-label">Filter low-reputation authors</span>
          <span className="settings-row-hint">
            Hide authors missing from Fayan or below the {FAYAN_MIN_PERCENTILE}
            th percentile. If Fayan is unavailable, the feed stays unfiltered.
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
            Hide notes with 4 or more hashtag tags on the event. Spammers often
            bury these in tags without showing them in the note text.
          </span>
        </span>
        <input
          id={hashtagFilterId}
          className="settings-toggle"
          type="checkbox"
          checked={hashtagFilter}
          onChange={(event) => setHashtagFilterEnabled(event.target.checked)}
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
                <span className="settings-muted-name">
                  {profileLabel(pubkey, profiles[pubkey]?.displayName)}
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
      <button
        type="button"
        className="open-in-cancel"
        onClick={() => dialogRef.current?.close()}
      >
        Done
      </button>
    </dialog>
  );
}
