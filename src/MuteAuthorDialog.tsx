import { useEffect, useId, useRef } from "react";

export function MuteAuthorDialog({
  authorLabel,
  onConfirm,
  onClose,
}: {
  authorLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
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

  const closeDialog = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      className="open-in-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <h2 id={titleId} className="open-in-title">
        Mute author?
      </h2>
      <p id={descriptionId} className="confirm-dialog-text">
        Notes from <strong>{authorLabel}</strong> will be hidden from your
        feed. You can unmute authors anytime in Settings.
      </p>
      <div className="open-in-list">
        <button
          type="button"
          className="danger"
          onClick={() => {
            onConfirm();
            closeDialog();
          }}
        >
          Mute {authorLabel}
        </button>
        <button type="button" className="secondary" onClick={closeDialog}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
