import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Avatar } from "./Avatar";
import {
  encodeNpub,
  isNip05,
  readCachedNip05Verified,
  verifyNip05,
  type Kind0Profile,
} from "./identity";
import {
  fetchPaytoTags,
  readCachedKind0CachedAt,
  readCachedPaytoCachedAt,
  readCachedPaytoTags,
} from "./nostr";
import {
  hasProfilePaymentTargets,
  mergePaymentTargets,
  paymentTargetDetails,
  paymentTargetsFromPaytoTags,
  paymentTargetsFromProfile,
  type PaymentTarget,
} from "./paymentTargets";
import { QrCode } from "./QrCode";

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

  const npubFingerprint = useMemo(() => formatNpubFingerprint(pubkey), [pubkey]);
  const nip05 = useMemo(() => {
    const value = profile?.nip05?.trim() ?? "";
    if (!value || !isNip05(value)) return "";
    if (value.toLowerCase() === authorLabel.trim().toLowerCase()) return "";
    return value;
  }, [profile?.nip05, authorLabel]);
  const [nip05Verified, setNip05Verified] = useState<boolean | null>(() =>
    nip05 ? readCachedNip05Verified(pubkey, nip05) : null
  );
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
  const [freshnessTick, setFreshnessTick] = useState(0);

  const targets = useMemo(
    () => mergePaymentTargets(profileTargets, extra),
    [profileTargets, extra]
  );
  const selected =
    targets.find((target) => target.id === selectedId) ?? targets[0];
  const selectedDetails = selected ? paymentTargetDetails(selected) : null;
  const freshnessLabel = useMemo(() => {
    void freshnessTick;
    if (!selected) return null;
    const cachedAt =
      selected.source === "profile"
        ? readCachedKind0CachedAt(pubkey)
        : readCachedPaytoCachedAt(pubkey);
    return formatCacheAge(cachedAt);
  }, [selected, pubkey, freshnessTick]);

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
    setFreshnessTick((n) => n + 1);

    let cancelled = false;
    void fetchPaytoTags(pubkey).then((tags) => {
      if (cancelled) return;
      setExtra(paymentTargetsFromPaytoTags(tags));
      setExtraStatus("done");
      setFreshnessTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  useEffect(() => {
    if (!nip05) {
      setNip05Verified(null);
      return;
    }
    const cached = readCachedNip05Verified(pubkey, nip05);
    setNip05Verified(cached);
    if (cached !== null) return;

    let cancelled = false;
    void verifyNip05(pubkey, nip05).then((ok) => {
      if (!cancelled) setNip05Verified(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, nip05]);

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
            <div className="tip-recipient">
              <Avatar src={profile?.picture} pubkey={pubkey} />
              <div className="tip-recipient-copy">
                <p className="tip-subtitle">Send to {authorLabel}</p>
                {nip05 ? (
                  <p className="tip-nip05">
                    <span className="tip-nip05-text" title={nip05}>
                      {nip05}
                    </span>
                    {nip05Verified ? (
                      <span
                        className="tip-nip05-verified"
                        title="NIP-05 verified"
                        aria-label="NIP-05 verified"
                      >
                        <Nip05VerifiedIcon />
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {npubFingerprint ? (
                  <p className="tip-npub" title={encodeNpub(pubkey)}>
                    {npubFingerprint}
                  </p>
                ) : null}
              </div>
            </div>
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

          {selected && selectedDetails ? (
            <div className="tip-selected">
              {targets.length === 1 ? (
                <p className="tip-method-label">{selected.label}</p>
              ) : null}
              <dl className="tip-confirm">
                <div>
                  <dt>Source</dt>
                  <dd>
                    {selectedDetails.sourceLabel}
                    {freshnessLabel ? ` · ${freshnessLabel}` : null}
                  </dd>
                </div>
                {selectedDetails.network ? (
                  <div>
                    <dt>Network</dt>
                    <dd>{selectedDetails.network}</dd>
                  </div>
                ) : null}
                {selectedDetails.amount ? (
                  <div>
                    <dt>Amount</dt>
                    <dd>{selectedDetails.amount}</dd>
                  </div>
                ) : null}
              </dl>
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

function formatNpubFingerprint(pubkey: string): string {
  const npub = encodeNpub(pubkey);
  if (!npub || npub.length < 16) return "";
  return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
}

function Nip05VerifiedIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 0a6 6 0 1 1 0 12A6 6 0 0 1 6 0Zm2.6 4.15a.75.75 0 0 0-1.06-.05L5.2 6.3 4.4 5.5a.75.75 0 1 0-1.06 1.06l1.35 1.35c.3.3.78.28 1.05-.03l2.91-3.18a.75.75 0 0 0-.05-1.05Z"
      />
    </svg>
  );
}

function formatCacheAge(cachedAt: number | null): string | null {
  if (cachedAt == null) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - cachedAt) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.max(1, Math.floor(seconds / 3600))}h ago`;
  return `${Math.max(1, Math.floor(seconds / 86400))}d ago`;
}
