import { useEffect, useState } from "react";
import type { LightningInvoice } from "./lightningInvoice";
import { QrCode } from "./QrCode";

export function LightningInvoiceCard({ invoice }: { invoice: LightningInvoice }) {
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(() => Date.now() >= invoice.expiresAt);

  useEffect(() => {
    let timer = 0;
    const checkExpiry = () => {
      const delay = invoice.expiresAt - Date.now();
      setExpired(delay <= 0);
      if (delay > 0) {
        timer = window.setTimeout(checkExpiry, Math.min(delay, 2_147_483_647));
      }
    };
    checkExpiry();
    return () => window.clearTimeout(timer);
  }, [invoice.expiresAt]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const networkLabel = invoice.network.replace(/^Bitcoin(?: )?/, "");
  const meta = [networkLabel, expired ? invoice.amount : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="invoice-card">
      <div className="invoice-card-heading">
        <span className="invoice-card-title">⚡ Lightning invoice</span>
        <span className={expired ? "invoice-card-expired" : "invoice-card-amount"}>
          {expired ? "Expired" : invoice.amount}
        </span>
      </div>
      {meta ? <p className="invoice-card-meta">{meta}</p> : null}
      <QrCode
        value={invoice.uri}
        label="QR code for Lightning invoice"
        fallback="Invoice is too long for a QR code. Copy it instead."
      />
      <div className="invoice-card-actions">
        <button type="button" onClick={() => {
          void navigator.clipboard.writeText(invoice.raw).then(
            () => setCopied(true),
            () => setCopied(false)
          );
        }}>{copied ? "Copied" : "Copy"}</button>
        {!expired ? <a href={invoice.uri}>Open wallet</a> : null}
      </div>
      <details className="invoice-card-details">
        <summary>View invoice</summary>
        <p className="invoice-card-raw">{invoice.raw}</p>
      </details>
    </div>
  );
}
