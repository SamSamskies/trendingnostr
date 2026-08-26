import { useEffect, useId, useRef, useState } from "react";
import {
  clientHref,
  clientsForPlatform,
  detectClientPlatform,
  isWebClientHref,
  type OpenInKind,
} from "./nostr-clients";
import {
  addressPlaceholderLinks,
  fetchAddressOpenInLinks,
  type OpenInLink,
} from "./nip89";

export type OpenInTarget = {
  kind: OpenInKind;
  code: string;
};

export function NoteMenuIcon() {
  return (
    <svg className="note-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.65" fill="currentColor" />
      <circle cx="12" cy="12" r="1.65" fill="currentColor" />
      <circle cx="18" cy="12" r="1.65" fill="currentColor" />
    </svg>
  );
}

function staticOpenInLinks(kind: OpenInKind, code: string): OpenInLink[] {
  return clientsForPlatform(detectClientPlatform()).map((client) => ({
    id: client.id,
    name: client.name,
    href: clientHref(client, code, kind),
  }));
}

export function OpenInDialog({
  target,
  onClose,
}: {
  target: OpenInTarget;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { kind, code } = target;
  const isAddress = kind === "address";
  const [links, setLinks] = useState<OpenInLink[]>(() =>
    isAddress ? addressPlaceholderLinks(code) : staticOpenInLinks(kind, code)
  );
  const [loading, setLoading] = useState(isAddress);
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

  useEffect(() => {
    if (!isAddress) {
      setLinks(staticOpenInLinks(kind, code));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLinks(addressPlaceholderLinks(code));
    setLoading(true);
    void fetchAddressOpenInLinks(code).then((next) => {
      if (cancelled) return;
      setLinks(next);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [isAddress, kind, code]);

  if (!code) return null;

  return (
    <dialog
      ref={dialogRef}
      className="open-in-dialog"
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <h2 id={titleId} className="open-in-title">
        Open in
      </h2>
      <div className="open-in-list">
        {links.map((link, index) => (
          <a
            key={link.id}
            className={
              index === 0 ? "open-in-link primary" : "open-in-link secondary"
            }
            href={link.href}
            {...(isWebClientHref(link.href)
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {link.name}
          </a>
        ))}
        {loading ? (
          <p className="open-in-status">Looking up apps…</p>
        ) : null}
      </div>
      <button
        type="button"
        className="open-in-cancel"
        onClick={() => dialogRef.current?.close()}
      >
        Cancel
      </button>
    </dialog>
  );
}
