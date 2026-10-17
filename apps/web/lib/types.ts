// Frontend view models. Built on the server from @agent-wallet/core's dashboard snapshot
// (lib/server/snapshot.ts). Money here is in dollars; the backend works in cents.

import type { PolicyRules } from "@agent-wallet/core/pure";

export type AgentStatus = "active" | "frozen";
export type AgentClient = "claude" | "chatgpt" | "custom";

/** Category ids are open-ended snake_case strings; known ones have labels in format.ts. */
export type Category = string;

/** The backend's policy rules plus the version they were saved as. Amounts in dollars. */
export type Policy = PolicyRules & { version: number };

export interface SpendSnapshot {
  /** Spent plus reserved by requests still in flight, per rolling window. */
  today: number;
  week: number;
  month: number;
  ordersToday: number;
}

export interface Agent {
  id: string;
  name: string;
  client: AgentClient;
  status: AgentStatus;
  /** 0 (new) to 5. */
  trustLevel: number;
  createdAt: number;
  keyPrefix: string;
  keyRevoked: boolean;
  policy: Policy;
  spend: SpendSnapshot;
}

export interface CartItem {
  name: string;
  category: Category;
  categoryConfidence: number; // 0..1
  unitPrice: number;
  quantity: number;
  /** http(s) only; null when the agent gave none or it wasn't a safe link. */
  url: string | null;
}

export type CheckOutcome = "pass" | "approval" | "deny";

export interface RuleCheck {
  rule: string;
  outcome: CheckOutcome;
  detail: string;
}

export type RequestStatus =
  | "denied"
  | "pending_approval"
  | "approved"
  | "credential_issued"
  | "completed"
  | "expired"
  | "cancelled";

export interface IssuedCredential {
  last4: string;
  amountLimit: number;
  expiresAt: number;
  status: "active" | "used" | "cancelled" | "expired";
}

export interface PurchaseRequest {
  id: string;
  agentId: string;
  merchantDomain: string;
  merchantName: string;
  items: CartItem[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  currency: string;
  reasoning: string;
  cartHash: string;
  status: RequestStatus;
  checks: RuleCheck[];
  createdAt: number;
  decidedAt?: number;
  credential?: IssuedCredential;
}

export type AuditType =
  | "request_denied"
  | "request_pending"
  | "request_auto_approved"
  | "approved"
  | "denied"
  | "credential_issued"
  | "credential_cancelled"
  | "transaction"
  | "security"
  | "refund"
  | "policy_changed"
  | "frozen"
  | "unfrozen"
  | "agent_created"
  | "other";

export type Tone = "info" | "good" | "hold" | "stop";

export interface AuditEvent {
  id: string;
  agentId: string | null;
  type: AuditType;
  /** The backend event type, e.g. "security.authorization_declined". */
  rawType: string;
  summary: string;
  requestId?: string;
  createdAt: number;
}

export interface TrustSuggestion {
  id: string;
  agentId: string;
  evidence: string;
  proposal: string;
}

export interface Snapshot {
  userEmail: string;
  agents: Agent[];
  requests: PurchaseRequest[];
  events: AuditEvent[];
  suggestions: TrustSuggestion[];
}
