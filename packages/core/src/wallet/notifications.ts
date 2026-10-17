import type { CartItem } from "../cart";
import { formatMoney } from "../money";
import { escapeHtml } from "../security";
import type { WalletDeps } from "./context";

export interface ApprovalNotice {
  userId: string;
  requestId: string;
  agentName: string;
  merchantName: string;
  merchantDomain: string;
  items: CartItem[];
  totalCents: number;
  currency: string;
  reasons: string[];
}

export interface SecurityNotice {
  userId: string;
  agentName: string;
  title: string;
  detail: string;
  link: string;
}

/**
 * Sends approval and security notifications by email and web push. Links always point at
 * confirmation pages in the dashboard; nothing in a notification approves anything by itself.
 * All agent-supplied text is escaped for HTML.
 */
export class Notifications {
  constructor(private readonly deps: WalletDeps) {}

  approvalUrl(requestId: string): string {
    return `${this.deps.config.appUrl.replace(/\/$/, "")}/approvals/${encodeURIComponent(requestId)}`;
  }

  async approvalNeeded(n: ApprovalNotice): Promise<void> {
    const user = await this.deps.db.user.findUnique({ where: { id: n.userId }, include: { pushSubscriptions: true } });
    if (!user) return;
    const total = formatMoney(n.totalCents, n.currency);
    const url = this.approvalUrl(n.requestId);
    const subject = `Approve ${total} at ${clip(n.merchantName, 40)}? (${clip(n.agentName, 30)})`;
    const itemLines = n.items.map((i) => `${i.quantity} × ${clip(i.name, 120)} — ${formatMoney(i.unit_price_cents * i.quantity, n.currency)}`);

    const text = [
      `${n.agentName} wants to spend ${total} at ${n.merchantName} (${n.merchantDomain}).`,
      "",
      ...itemLines,
      "",
      "Why it needs you:",
      ...n.reasons.map((r) => `- ${r}`),
      "",
      `Review and approve or deny: ${url}`,
      "",
      "Nothing is approved until you confirm on that page.",
    ].join("\n");

    const button = (label: string, intent: string, color: string) =>
      `<a href="${escapeHtml(`${url}?intent=${intent}`)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:600;margin-right:8px">${label}</a>`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:16px">
<h2 style="margin:0 0 8px">${escapeHtml(n.agentName)} wants to spend ${escapeHtml(total)}</h2>
<p style="margin:0 0 16px;color:#555">at ${escapeHtml(n.merchantName)} (${escapeHtml(n.merchantDomain)})</p>
<ul>${itemLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
<p><strong>Why it needs you:</strong></p>
<ul>${n.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
<p>${button("Approve…", "approve", "#15803d")}${button("Deny…", "deny", "#b91c1c")}</p>
<p style="color:#777;font-size:13px">Both buttons open a confirmation page. Nothing happens until you confirm there while signed in.</p>
</body></html>`;

    await this.safe("approval email", () => this.deps.email.send({ to: user.email, subject, text, html }));
    for (const sub of user.pushSubscriptions) {
      await this.safe("approval push", async () => {
        const r = await this.deps.push.send(sub, {
          title: `Approve ${total}?`,
          body: `${clip(n.agentName, 30)} at ${clip(n.merchantName, 40)}`,
          url,
          tag: `approval-${n.requestId}`,
          actions: [
            { action: "approve", title: "Approve…" },
            { action: "deny", title: "Deny…" },
          ],
        });
        if (r === "gone") await this.deps.db.pushSubscription.deleteMany({ where: { id: sub.id } });
      });
    }
  }

  async securityAlert(n: SecurityNotice): Promise<void> {
    const user = await this.deps.db.user.findUnique({ where: { id: n.userId }, include: { pushSubscriptions: true } });
    if (!user) return;
    const subject = `Security alert: ${clip(n.title, 80)}`;
    const text = `${n.title}\n\nAgent: ${n.agentName}\n${n.detail}\n\nDetails: ${n.link}\n\nYou can freeze the agent from the dashboard.`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:16px">
<h2 style="color:#b91c1c">${escapeHtml(n.title)}</h2><p>Agent: ${escapeHtml(n.agentName)}</p><p>${escapeHtml(n.detail)}</p>
<p><a href="${escapeHtml(n.link)}">Open activity log</a> — you can freeze the agent from the dashboard.</p></body></html>`;
    await this.safe("security email", () => this.deps.email.send({ to: user.email, subject, text, html }));
    for (const sub of user.pushSubscriptions) {
      await this.safe("security push", () => this.deps.push.send(sub, { title: "Security alert", body: clip(n.title, 120), url: n.link, tag: "security" }));
    }
  }

  private async safe(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.deps.logger.error(`notification failed: ${what}`, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
