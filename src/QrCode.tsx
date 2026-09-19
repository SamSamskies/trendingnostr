import { useMemo } from "react";
import { encodeQrMatrix } from "./qr";

export function QrCode({ value, label, fallback = "Could not make a QR code for this address." }: { value: string; label: string; fallback?: string }) {
  const matrix = useMemo(() => encodeQrMatrix(value), [value]);
  if (!matrix) {
    return <p className="payment-qr-error">{fallback}</p>;
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
    <div className="payment-qr-wrap">
      <svg className="payment-qr" viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" role="img" aria-label={label}>
        <rect width={dim} height={dim} fill="#fff" />
        <path d={parts.join("")} fill="#1c1f18" />
      </svg>
    </div>
  );
}
