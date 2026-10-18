import webpush from "web-push";
import type { Logger } from "../logger";
import type { EmailMessage, EmailSender, PushMessage, PushResult, PushSender, PushTarget } from "./types";

/** Dev fallback: prints emails to the log. */
export class ConsoleEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly logger: Logger) {}
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    this.logger.info("email (console)", { to: message.to, subject: message.subject, text: message.text });
    // The JSON line escapes newlines, which glues "\n\nThe…" onto any link in the body and breaks
    // it when clicked in a terminal. Print the body plainly too so links open as-is.
    if (process.env["NODE_ENV"] !== "test") {
      console.log(`\n──── email to ${message.to}: ${message.subject} ────\n${message.text}\n────\n`);
    }
  }
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export class ConsolePushSender implements PushSender {
  readonly sent: { target: PushTarget; message: PushMessage }[] = [];
  constructor(private readonly logger: Logger) {}
  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    this.sent.push({ target, message });
    this.logger.info("push (console)", { endpoint: target.endpoint.slice(0, 40), title: message.title, url: message.url });
    return "sent";
  }
}

/** Standard Web Push with VAPID keys (`npx web-push generate-vapid-keys`). */
export class WebPushSender implements PushSender {
  constructor(vapid: { subject: string; publicKey: string; privateKey: string }) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        { TTL: 15 * 60, urgency: "high" },
      );
      return "sent";
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? "gone" : "failed";
    }
  }
}
