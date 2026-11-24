import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import type { MediaKind } from "./media";
import {
  getCachedHtreeMediaUrl,
  isHtreeUrl,
  resolveHtreeMediaUrl,
} from "./htree";

export type NoteMediaItem = {
  kind: MediaKind;
  url: string;
};

export type ResolvedMediaState =
  | { status: "ready"; src: string }
  | { status: "loading" }
  | { status: "error" };

export function useResolvedMediaUrl(url: string): ResolvedMediaState {
  const [state, setState] = useState<ResolvedMediaState>(() => {
    if (!url || !isHtreeUrl(url)) return { status: "ready", src: url };
    const cached = getCachedHtreeMediaUrl(url);
    return cached ? { status: "ready", src: cached } : { status: "loading" };
  });

  useEffect(() => {
    if (!url || !isHtreeUrl(url)) {
      setState({ status: "ready", src: url });
      return;
    }

    const cached = getCachedHtreeMediaUrl(url);
    if (cached) {
      setState({ status: "ready", src: cached });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    void resolveHtreeMediaUrl(url).then((resolved) => {
      if (cancelled) return;
      if (resolved) {
        setState({ status: "ready", src: resolved });
      } else {
        setState({ status: "error" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function PlayBadge() {
  return (
    <span className="note-media-grid-play" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M8.5 6.8v10.4L18 12 8.5 6.8z" fill="currentColor" />
      </svg>
    </span>
  );
}

const SWIPE_THRESHOLD_PX = 48;

function MediaLightbox({
  items,
  index,
  onClose,
  onIndexChange,
}: {
  items: NoteMediaItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const count = items.length;
  const current = clampIndex(index, count);
  const item = items[current];
  const resolved = useResolvedMediaUrl(item?.url ?? "");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const swipeRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);

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
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (count <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onIndexChange(clampIndex(current - 1, count));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onIndexChange(clampIndex(current + 1, count));
      }
    };

    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [current, count, onIndexChange]);

  function clearSwipe() {
    swipeRef.current = null;
  }

  function onSwipePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (count <= 1) return;
    if (event.pointerType === "mouse") return;
    swipeRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }

  function onSwipePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipeRef.current;
    clearSwipe();
    if (!start || start.pointerId !== event.pointerId) return;

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    if (Math.abs(dx) <= Math.abs(dy)) return;

    if (dx > 0) onIndexChange(clampIndex(current - 1, count));
    else onIndexChange(clampIndex(current + 1, count));
  }

  if (!item) return null;

  return (
    <dialog
      ref={dialogRef}
      className="note-media-lightbox"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="note-media-lightbox-chrome">
        <p id={titleId} className="note-media-lightbox-count" aria-live="polite">
          {count > 1 ? `${current + 1} / ${count}` : "Media"}
        </p>
        <button
          type="button"
          className="note-media-lightbox-close"
          aria-label="Close"
          onClick={() => dialogRef.current?.close()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="note-media-lightbox-stage" data-single={count === 1 ? "" : undefined}>
        {count > 1 ? (
          <button
            type="button"
            className="note-media-lightbox-nav"
            aria-label="Previous media"
            disabled={current === 0}
            onClick={() => onIndexChange(current - 1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M14.5 5.5 8 12l6.5 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}

        <div
          className="note-media-lightbox-media"
          data-swipeable={count > 1 ? "" : undefined}
          onPointerDown={onSwipePointerDown}
          onPointerUp={onSwipePointerUp}
          onPointerCancel={clearSwipe}
        >
          {resolved.status === "loading" ? (
            <div className="note-media-lightbox-status" role="status">
              Loading Hashtree media…
            </div>
          ) : resolved.status === "error" ? (
            <div className="note-media-lightbox-status">
              Unable to load Hashtree media
            </div>
          ) : item.kind === "image" ? (
            <img src={resolved.src} alt="" decoding="async" draggable={false} />
          ) : (
            <video key={resolved.src} src={resolved.src} controls autoPlay playsInline>
              {item.url}
            </video>
          )}
        </div>

        {count > 1 ? (
          <button
            type="button"
            className="note-media-lightbox-nav"
            aria-label="Next media"
            disabled={current === count - 1}
            onClick={() => onIndexChange(current + 1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M9.5 5.5 16 12l-6.5 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
      </div>
    </dialog>
  );
}

function MediaGridTile({
  item,
  index,
  count,
  onOpen,
}: {
  item: NoteMediaItem;
  index: number;
  count: number;
  onOpen: (index: number) => void;
}) {
  const resolved = useResolvedMediaUrl(item.url);

  if (resolved.status === "loading") {
    return (
      <div
        className="note-media-grid-item note-media-grid-item-loading"
        role="status"
        aria-label="Loading Hashtree media"
      >
        <span className="note-media-status-label">Loading media…</span>
      </div>
    );
  }

  if (resolved.status === "error") {
    return (
      <div className="note-media-grid-item note-media-grid-item-error">
        <span className="note-media-status-label">Unable to load media</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="note-media-grid-item"
      aria-label={
        item.kind === "video"
          ? count === 1
            ? "Play video"
            : `Play video ${index + 1} of ${count}`
          : count === 1
            ? "View larger image"
            : `View image ${index + 1} of ${count}`
      }
      onClick={() => onOpen(index)}
    >
      {item.kind === "image" ? (
        <img
          className="note-media-grid-thumb"
          src={resolved.src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <>
          <video
            className="note-media-grid-thumb"
            src={resolved.src}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
          />
          <PlayBadge />
        </>
      )}
    </button>
  );
}

export function MediaGrid({ items }: { items: NoteMediaItem[] }) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const count = items.length;

  if (count === 0) return null;

  return (
    <>
      <div
        className="note-media-grid"
        data-count={count}
        aria-label={
          count === 1 ? "Media attachment" : `${count} media attachments`
        }
      >
        {items.map((item, index) => (
          <MediaGridTile
            key={`${item.kind}:${item.url}:${index}`}
            item={item}
            index={index}
            count={count}
            onOpen={setViewerIndex}
          />
        ))}
      </div>

      {viewerIndex !== null ? (
        <MediaLightbox
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
        />
      ) : null}
    </>
  );
}
