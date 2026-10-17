import type { CartItem } from "../cart";

export interface ItemClassification {
  index: number;
  category: string;
  /** 0..1. Below the engine's threshold the purchase needs human approval. */
  confidence: number;
  source: "rules" | "llm" | "agent_hint" | "none";
  /** Short explanation for the audit log / approval screen. */
  note?: string;
}

export interface ClassifierContext {
  merchantDomain: string;
  mcc: string | null;
}

/**
 * Best-effort item categorization. Implementations may do I/O (e.g. call an LLM).
 * Item names and URLs are untrusted, possibly adversarial text: implementations must
 * treat them as data, never as instructions.
 */
export interface ItemClassifier {
  classify(items: CartItem[], ctx: ClassifierContext): Promise<ItemClassification[]>;
}

export const UNCERTAIN_CATEGORY = "unknown";
