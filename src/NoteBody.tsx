import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Must match `--note-body-collapsed-max` in index.css. */
const COLLAPSED_MAX_HEIGHT_PX = 440;

/**
 * Lazy images/videos often have 0 height until loaded. Estimate a 4:5 box so
 * overflow is detected before media loads (avoids expand-then-collapse).
 * Only add the deficit vs current layout height — scrollHeight may already
 * include a partial box while complete/metadata is still false.
 */
function unloadedMediaExtraHeight(root: HTMLElement): number {
  let extra = 0;

  for (const img of root.querySelectorAll<HTMLImageElement>("img.note-image")) {
    if (img.complete) continue;
    const width = img.clientWidth || root.clientWidth;
    if (width <= 0) continue;
    extra += Math.max(0, (width * 5) / 4 - img.clientHeight);
  }

  for (const video of root.querySelectorAll<HTMLVideoElement>(
    "video.note-video"
  )) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) continue;
    const width = video.clientWidth || root.clientWidth;
    if (width <= 0) continue;
    extra += Math.max(0, (width * 5) / 4 - video.clientHeight);
  }

  return extra;
}

function isClippedByOverflow(content: HTMLElement, target: HTMLElement): boolean {
  const contentRect = content.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  // Fully or partially below the visible max-height clip.
  return targetRect.bottom > contentRect.bottom + 1;
}

export function NoteBody({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Measure before paint so long notes never flash at full height then snap closed.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const height = el.scrollHeight + unloadedMediaExtraHeight(el);
      setOverflows(height > COLLAPSED_MAX_HEIGHT_PX + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    // Lazy media may not resize the container until load/error; remeasure then.
    el.addEventListener("load", measure, true);
    el.addEventListener("error", measure, true);
    el.addEventListener("loadedmetadata", measure, true);

    return () => {
      observer.disconnect();
      el.removeEventListener("load", measure, true);
      el.removeEventListener("error", measure, true);
      el.removeEventListener("loadedmetadata", measure, true);
    };
  }, []);

  const collapsed = overflows && !expanded;

  // Overflow:hidden hides clipped links visually but leaves them in the tab order.
  // Send focus to "Show more" when Tab lands on content below the cutoff.
  useLayoutEffect(() => {
    if (!collapsed) return;
    const content = contentRef.current;
    if (!content) return;

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !content.contains(target)) return;
      if (target === content || !isClippedByOverflow(content, target)) return;
      toggleRef.current?.focus();
    };

    content.addEventListener("focusin", onFocusIn);
    return () => content.removeEventListener("focusin", onFocusIn);
  }, [collapsed]);

  return (
    <div className={`note-body${collapsed ? " note-body-collapsed" : ""}`}>
      <div ref={contentRef} className="note-body-content">
        {children}
      </div>
      {overflows ? (
        <button
          ref={toggleRef}
          type="button"
          className="note-body-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
