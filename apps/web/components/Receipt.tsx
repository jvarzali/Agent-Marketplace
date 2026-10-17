import { categoryLabel, clockTime, money, safeLink } from "@/lib/format";
import type { Agent, PurchaseRequest } from "@/lib/types";

const LOW_CONFIDENCE = 0.7;

/**
 * A purchase request drawn as a receipt. All text here is agent-supplied and
 * untrusted: it is only ever rendered as React text nodes, and links are
 * restricted to http(s) and marked nofollow.
 */
export function Receipt({
  request: r,
  agent,
  compact = false,
}: {
  request: PurchaseRequest;
  agent?: Agent;
  compact?: boolean;
}) {
  const stamp =
    r.status === "credential_issued" || r.status === "approved" || r.status === "completed"
      ? { cls: "stamp--ok", text: "Approved" }
      : r.status === "denied"
        ? { cls: "stamp--no", text: "Denied" }
        : r.status === "cancelled"
          ? { cls: "stamp--void", text: "Cancelled" }
          : null;

  return (
    <article className={`receipt${compact ? " receipt--compact" : ""}`} aria-label={`Cart from ${r.merchantName}`}>
      <header className="receipt__head">
        <p className="receipt__merchant">{r.merchantName}</p>
        <p className="receipt__muted">{r.merchantDomain}</p>
        <p className="receipt__muted">
          {agent ? `${agent.name}, ` : ""}
          {new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} {clockTime(r.createdAt)}
        </p>
      </header>

      <ul className="receipt__items">
        {r.items.map((item, i) => {
          const link = safeLink(item.url);
          const unsure = item.categoryConfidence < LOW_CONFIDENCE;
          return (
            <li key={i} className="receipt__item">
              <div className="receipt__row">
                <span>
                  {item.quantity > 1 && <span className="receipt__qty">{item.quantity} × </span>}
                  {item.name}
                </span>
                <span className="receipt__amt">{money(item.unitPrice * item.quantity)}</span>
              </div>
              {!compact && (
                <div className="receipt__meta">
                  <span className={unsure ? "receipt__unsure" : undefined}>
                    {unsure ? `Unclear category (${Math.round(item.categoryConfidence * 100)}% sure)` : categoryLabel[item.category]}
                  </span>
                  {link.href ? (
                    <a href={link.href} target="_blank" rel="noopener noreferrer nofollow" className="receipt__link">
                      View on {link.domain}
                    </a>
                  ) : (
                    <span>{link.domain}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <dl className="receipt__totals">
        <div className="receipt__row">
          <dt>Subtotal</dt>
          <dd className="receipt__amt">{money(r.subtotal)}</dd>
        </div>
        <div className="receipt__row">
          <dt>Tax</dt>
          <dd className="receipt__amt">{money(r.tax)}</dd>
        </div>
        <div className="receipt__row">
          <dt>Shipping</dt>
          <dd className="receipt__amt">{r.shipping ? money(r.shipping) : "Free"}</dd>
        </div>
        <div className="receipt__row receipt__total">
          <dt>Total</dt>
          <dd className="receipt__amt">{money(r.total)}</dd>
        </div>
      </dl>

      {!compact && (
        <footer className="receipt__foot">
          Cart {r.cartHash.slice(0, 12)}
          {r.credential && (
            <>
              <br />
              Card ending {r.credential.last4}, limit {money(r.credential.amountLimit)}
            </>
          )}
        </footer>
      )}

      {stamp && (
        <span className={`stamp ${stamp.cls}`} aria-hidden="true">
          {stamp.text}
        </span>
      )}
    </article>
  );
}
