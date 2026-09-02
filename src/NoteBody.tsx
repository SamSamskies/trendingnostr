import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Must match `--note-body-collapsed-max` in index.css. */
const COLLAPSED_MAX_HEIGHT_PX = 440;

/**
 * Lazy images/videos often have 0 height until loaded. Estimate a 9:16 box
 * (tall portrait / story) so overflow is detected before media loads and we
 * avoid expand-then-collapse. Prefer overestimating vs understating taller
 * media. Only add the deficit vs current layout height — scrollHeight may
 * already include a partial box while complete/metadata is still false.
 */
function unloadedMediaExtraHeight(root: HTMLElement): number {
  let extra = 0;

  for (const img of root.querySelectorAll<HTMLImageElement>("img.note-image")) {
    // Grids use square cells with aspect-ratio; don't double-count lazy thumbs.
    if (img.closest(".note-media-grid")) continue;
    if (img.complete) continue;
    const width = img.clientWidth || root.clientWidth;
    if (width <= 0) continue;
    extra += Math.max(0, (width * 16) / 9 - img.clientHeight);
  }

  for (const video of root.querySelectorAll<HTMLVideoElement>(
    "video.note-video"
  )) {
    if (video.closest(".note-media-grid")) continue;
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) continue;
    const width = video.clientWidth || root.clientWidth;
    if (width <= 0) continue;
    extra += Math.max(0, (width * 16) / 9 - video.clientHeight);
  }

  // Link-preview cards reserve ~100px; unfinished thumbnails shouldn't understate height.
  for (const card of root.querySelectorAll<HTMLElement>(".note-link-preview")) {
    extra += Math.max(0, 100 - card.clientHeight);
  }

  return extra;
}

function isClippedByOverflow(content: HTMLElement, target: HTMLElement): boolean {
  const contentRect = content.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  // Fully or partially below the visible max-height clip.
  return targetRect.bottom > contentRect.bottom + 1;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0
  );
}

/** Last tab stop in document order that precedes `content` (and is not inside it). */
function focusPreviousOutside(content: HTMLElement): void {
  const all = getFocusableElements(content.ownerDocument.body);
  let previous: HTMLElement | undefined;
  for (const el of all) {
    if (el === content || content.contains(el)) break;
    previous = el;
  }
  previous?.focus();
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
  // Tab into clipped content → "Show more". Shift+Tab from "Show more" → skip
  // clipped nodes so focus can reach the author link / note menu.
  useLayoutEffect(() => {
    if (!collapsed) return;
    const content = contentRef.current;
    if (!content) return;

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !content.contains(target)) return;
      if (target === content || !isClippedByOverflow(content, target)) return;

      // Came from the toggle via Shift+Tab — do not bounce focus back onto it.
      if (event.relatedTarget === toggleRef.current) {
        const unclipped = getFocusableElements(content).filter(
          (el) => !isClippedByOverflow(content, el)
        );
        if (unclipped.length > 0) {
          unclipped[unclipped.length - 1].focus();
        } else {
          focusPreviousOutside(content);
        }
        return;
      }

      toggleRef.current?.focus();
    };

    content.addEventListener("focusin", onFocusIn);
    return () => content.removeEventListener("focusin", onFocusIn);
  }, [collapsed]);

  return (
    <div className={`note-body${collapsed ? " note-body-collapsed" : ""}`}>
      <div className="note-body-clip">
        <div ref={contentRef} className="note-body-content">
          {children}
        </div>
        {collapsed ? (
          <button
            type="button"
            className="note-body-fade"
            aria-label="Show more"
            tabIndex={-1}
            onClick={() => {
              setExpanded(true);
              // This overlay unmounts on expand; move focus to the toggle so
              // it does not fall back to document.body.
              toggleRef.current?.focus();
            }}
          />
        ) : null}
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
