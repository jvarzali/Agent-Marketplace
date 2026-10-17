// Frontend view models. These mirror the data model in prompt.md §5 and will be
// replaced by types exported from /packages/core once the backend exists.

export type AgentStatus = "active" | "frozen";
export type AgentClient = "Claude" | "ChatGPT" | "Custom";

export type Category =
  | "groceries"
  | "household"
  | "pet_supplies"
  | "personal_care"
  | "electronics"
  | "office"
  | "gift_cards"
  | "stored_value"
  | "subscriptions"
  | "alcohol"
  | "firearms"
  | "unknown";

export interface Policy {
  version: number;
  merchants: {
    mode: "allowlist" | "any";
    allow_domains: string[];
    deny_mccs: string[];
  };
  categories: {
    allow: Category[];
    deny: Category[];
  };
  limits: {
    per_order_total: number;
    per_day: number;
    per_week: number;
    per_month: number;
    max_quantity_per_item: number;
    max_orders_per_day: number;
  };
  approval: {
    always: boolean;
    require_if_total_over: number | null;
    require_for_new_merchant: boolean;
    require_if_category_uncertain: boolean;
  };
  schedule: {
    timezone: string;
    allowed_hours: string | null; // "08:00-22:00" or null for any time
  };
  currency: "USD";
}

export interface SpendSnapshot {
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
  trustLevel: 1 | 2 | 3 | 4 | 5;
  createdAt: number;
  keyPrefix: string;
  policy: Policy;
  spend: SpendSnapshot;
}

export interface CartItem {
  name: string;
  category: Category;
  categoryConfidence: number; // 0..1
  unitPrice: number;
  quantity: number;
  url: string;
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
  currency: "USD";
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
  | "agent_created";

export type Tone = "info" | "good" | "hold" | "stop";

export interface AuditEvent {
  id: string;
  agentId: string;
  type: AuditType;
  summary: string;
  requestId?: string;
  createdAt: number;
}

export interface TrustSuggestion {
  id: string;
  agentId: string;
  evidence: string;
  proposal: string;
  apply: { require_if_total_over: number };
  status: "open" | "accepted" | "dismissed";
}
