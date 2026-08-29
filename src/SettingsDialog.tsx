import { useEffect, useId, useRef } from "react";
import { setWebSearchEnabled, useWebSearchEnabled } from "./settings";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const webSearchId = useId();
  const webSearch = useWebSearchEnabled();
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
