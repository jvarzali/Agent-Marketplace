export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opened when the notification is tapped. Always a confirmation page, never an action URL. */
  url: string;
  tag?: string;
  /** Rendered as notification action buttons by the service worker; each opens `url` with ?intent=. */
  actions?: { action: "approve" | "deny"; title: string }[];
}

export type PushResult = "sent" | "gone" | "failed";

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
}
