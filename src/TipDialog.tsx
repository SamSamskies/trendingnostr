import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { Kind0Profile } from "./identity";
import { fetchPaytoTags, readCachedPaytoTags } from "./nostr";
import {
  hasProfilePaymentTargets,
  mergePaymentTargets,
  paymentTargetsFromPaytoTags,
  paymentTargetsFromProfile,
  type PaymentTarget,
} from "./paymentTargets";
import { encodeQrMatrix } from "./qr";

export { hasProfilePaymentTargets };

const DRAWER_CLOSE_MS = 360;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TipButton({
  pubkey,
  pressed,
  onClick,
}: {
  pubkey: string;
  pressed: boolean;
  onClick: () => void;
}) {
  const prefetch = () => {
    void fetchPaytoTags(pubkey);
  };

  return (
    <button
      type="button"
      className="tip-btn"
      title="Tip"
      aria-pressed={pressed}
      aria-haspopup="dialog"
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onClick={onClick}
    >
      <TipBoltIcon />
      <span className="note-action-label">Tip</span>
    </button>
  );
}

function TipBoltIcon() {
  return (
    <svg className="tip-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13 3 5.5 13.5H12l-1 7.5L18.5 10.5H12L13 3Z"
      />
    </svg>
  );
}

export type TipDialogHandle = {
  close: () => void;
};

export function TipDialog({
  pubkey,
  profile,
  authorLabel,
  onClose,
  ref,
}: {
  pubkey: string;
  profile?: Kind0Profile;
  authorLabel: string;
  onClose: () => void;
  ref?: Ref<TipDialogHandle>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const startCloseRef = useRef<() => void>(() => {});
  const closeTimerRef = useRef(0);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const profileTargets = useMemo(
    () => paymentTargetsFromProfile(profile),
    [profile]
  );
  const [extra, setExtra] = useState<PaymentTarget[]>(() => {
    const tags = readCachedPaytoTags(pubkey);
    return tags ? paymentTargetsFromPaytoTags(tags) : [];
  });
  const [extraStatus, setExtraStatus] = useState<"loading" | "done">(() =>
    readCachedPaytoTags(pubkey) ? "done" : "loading"
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (profileTargets[0]?.id) return profileTargets[0].id;
    const tags = readCachedPaytoTags(pubkey);
    if (!tags) return null;
    return paymentTargetsFromPaytoTags(tags)[0]?.id ?? null;
  });
  const [copied, setCopied] = useState(false);

  const targets = useMemo(
    () => mergePaymentTargets(profileTargets, extra),
    [profileTargets, extra]
  );
  const selected =
    targets.find((target) => target.id === selectedId) ?? targets[0];

  useImperativeHandle(ref, () => ({
    close: () => startCloseRef.current(),
  }));

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
      if (event.animationName !== "tip-drawer-out") return;
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

  useEffect(() => {
    const cached = readCachedPaytoTags(pubkey);
    const cachedExtra = cached ? paymentTargetsFromPaytoTags(cached) : [];
    setExtra(cachedExtra);
    setExtraStatus(cached ? "done" : "loading");
    setSelectedId(null);
    setCopied(false);

    let cancelled = false;
    void fetchPaytoTags(pubkey).then((tags) => {
      if (cancelled) return;
      setExtra(paymentTargetsFromPaytoTags(tags));
      setExtraStatus("done");
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <dialog
      ref={dialogRef}
      className="tip-dialog"
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
      <div className="tip-sheet">
        <header className="tip-header">
          <div className="tip-heading">
            <h2 id={titleId}>Tip</h2>
            <p className="tip-subtitle">Send to {authorLabel}</p>
          </div>
          <button
            type="button"
            className="tip-close"
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

        <div className="tip-body">
          {targets.length > 1 ? (
            <div
              className="tip-methods"
              role="tablist"
              aria-label="Payment methods"
            >
              {targets.map((target) => {
                const isSelected = target.id === selected?.id;
                return (
                  <button
                    key={target.id}
                    type="button"
                    className="tip-method"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => {
                      setSelectedId(target.id);
                      setCopied(false);
                    }}
                  >
                    {target.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {selected ? (
            <div className="tip-selected">
              {targets.length === 1 ? (
                <p className="tip-method-label">{selected.label}</p>
              ) : null}
              <QrCode
                value={selected.uri}
                label={`QR code for ${selected.label} address`}
              />
              <p className="tip-address">{selected.uri}</p>
              <div className="tip-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    void navigator.clipboard.writeText(selected.uri).then(
                      () => setCopied(true),
                      () => setCopied(false)
                    );
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                {selected.openable ? (
                  <a
                    className="secondary"
                    href={selected.uri}
                    {...(selected.uri.startsWith("https:")
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                  >
                    Open wallet
                  </a>
                ) : null}
              </div>
            </div>
          ) : extraStatus === "done" ? (
            <p className="tip-empty">No payment addresses found.</p>
          ) : (
            <p className="tip-status">Looking up payment addresses…</p>
          )}

          {extraStatus === "loading" && targets.length > 0 ? (
            <p className="tip-status">Looking for more addresses…</p>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function QrCode({ value, label }: { value: string; label: string }) {
  const matrix = useMemo(() => encodeQrMatrix(value), [value]);
  if (!matrix) {
    return (
      <p className="tip-empty">Could not make a QR code for this address.</p>
    );
  }

  const quiet = 4;
  const dim = matrix.length + quiet * 2;
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }

  return (
    <div className="tip-qr-wrap">
      <svg
        className="tip-qr"
        viewBox={`0 0 ${dim} ${dim}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label={label}
      >
        <rect width={dim} height={dim} fill="#fff" />
        <path d={parts.join("")} fill="#1c1f18" />
      </svg>
    </div>
  );
}
