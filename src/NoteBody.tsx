import { useEffect, useRef, useState, type ReactNode } from "react";

/** Must match `--note-body-collapsed-max` in index.css. */
const COLLAPSED_MAX_HEIGHT_PX = 440;

export function NoteBody({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT_PX + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const collapsed = overflows && !expanded;

  return (
    <div className={`note-body${collapsed ? " note-body-collapsed" : ""}`}>
      <div ref={contentRef} className="note-body-content">
        {children}
      </div>
      {overflows ? (
        <button
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
