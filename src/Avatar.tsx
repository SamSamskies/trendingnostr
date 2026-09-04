import { useEffect, useState } from "react";

/** Soft, on-palette fills derived from pubkey so empty avatars differ per user. */
function colorFromPubkey(pubkey?: string): { background: string; color: string } {
  if (!pubkey) {
    return { background: "var(--canvas-deep)", color: "var(--muted)" };
  }

  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 33 + pubkey.charCodeAt(i)) >>> 0;
  }

  // Keep saturation/lightness muted so colors sit with the sage UI.
  const hue = hash % 360;
  return {
    background: `hsl(${hue} 32% 74%)`,
    color: `hsl(${hue} 24% 28%)`,
  };
}

function AnonAvatar({ pubkey }: { pubkey?: string }) {
  const style = colorFromPubkey(pubkey);

  return (
    <span className="avatar avatar-empty" style={style} aria-hidden="true">
      <svg
        className="avatar-person"
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="16" cy="12" r="6" fill="currentColor" />
        <path
          fill="currentColor"
          d="M6 28c0-5.5 4.5-9 10-9s10 3.5 10 9v1H6v-1Z"
        />
      </svg>
    </span>
  );
}

export function Avatar({ src, pubkey }: { src?: string; pubkey?: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return <AnonAvatar pubkey={pubkey} />;
  }

  return (
    <img
      className="avatar"
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
