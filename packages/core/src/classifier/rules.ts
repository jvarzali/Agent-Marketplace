import type { CartItem } from "../cart";
import { UNCERTAIN_CATEGORY, type ClassifierContext, type ItemClassification, type ItemClassifier } from "./types";

/**
 * Restricted categories are matched first and win over everything else, so a gift card
 * cannot hide inside an otherwise allowed cart by also mentioning "snacks".
 */
const RESTRICTED: Record<string, string[]> = {
  gift_cards: [
    "gift card", "giftcard", "e-gift", "egift", "gift certificate", "gift voucher", "steam wallet", "itunes card",
    "app store card", "google play card", "xbox card", "playstation store card", "psn card", "amazon card", "visa gift",
    "mastercard gift", "amex gift", "vanilla gift", "gift code",
  ],
  stored_value: [
    "prepaid card", "prepaid debit", "prepaid visa", "prepaid mastercard", "reload card", "reloadable", "stored value",
    "top up", "top-up", "account credit", "wallet credit", "add funds", "balance reload", "money order", "crypto",
    "bitcoin", "cash card",
  ],
  subscriptions: [
    "subscription", "subscribe & save", "subscribe and save", "monthly plan", "annual plan", "membership", "auto-renew",
    "autorenew", "recurring delivery", "per month", "/month", "/mo", "season pass",
  ],
  alcohol: ["wine", "beer", "vodka", "whiskey", "whisky", "bourbon", "tequila", "rum", "gin", "champagne", "prosecco", "liquor", "hard seltzer", "sake"],
  tobacco: ["cigarette", "cigar", "tobacco", "vape", "e-liquid", "nicotine"],
  firearms: ["firearm", "rifle", "pistol", "handgun", "shotgun", "ammunition", "ammo", "gun safe", "rounds of"],
};

const GENERAL: Record<string, string[]> = {
  groceries: [
    "milk", "eggs", "bread", "cheese", "butter", "yogurt", "banana", "bananas", "apple", "apples", "orange", "oranges",
    "avocado", "lettuce", "spinach", "tomato", "tomatoes", "potato", "potatoes", "onion", "onions", "garlic", "rice",
    "pasta", "flour", "sugar", "salt", "coffee", "tea", "cereal", "oatmeal", "oats", "chicken", "beef", "pork", "salmon",
    "tuna", "tofu", "beans", "lentils", "snack", "snacks", "chips", "crackers", "cookies", "juice", "water", "sparkling water",
    "soda", "olive oil", "peanut butter", "jam", "honey", "produce", "fruit", "vegetable", "vegetables", "frozen", "grocery",
    "organic", "almond milk", "oat milk", "granola", "nuts", "berries", "strawberries", "blueberries", "carrots", "broccoli",
  ],
  household: [
    "paper towel", "paper towels", "toilet paper", "tissue", "tissues", "dish soap", "dishwasher", "detergent", "laundry",
    "trash bag", "trash bags", "garbage bag", "sponge", "sponges", "cleaner", "cleaning", "disinfectant", "bleach",
    "light bulb", "batteries", "aluminum foil", "plastic wrap", "zip bags", "storage bags", "napkins", "broom", "mop",
  ],
  personal_care: ["shampoo", "conditioner", "toothpaste", "toothbrush", "deodorant", "soap", "body wash", "lotion", "sunscreen", "razor", "floss", "mouthwash"],
  pet_supplies: ["dog food", "cat food", "cat litter", "litter", "pet food", "dog treats", "cat treats", "chew toy", "leash", "pet", "kibble", "aquarium"],
  baby: ["diapers", "diaper", "wipes", "baby formula", "formula", "pacifier", "baby food"],
  office: ["printer paper", "pens", "pencils", "notebook", "stapler", "staples", "sticky notes", "folders", "envelopes", "toner", "ink cartridge", "binder"],
  electronics: ["usb", "charger", "cable", "hdmi", "headphones", "earbuds", "keyboard", "mouse", "monitor", "laptop", "tablet", "phone case", "ssd", "hard drive", "webcam"],
  apparel: ["shirt", "t-shirt", "pants", "jeans", "socks", "jacket", "shoes", "sneakers", "dress", "sweater", "hoodie"],
  pharmacy: ["vitamin", "vitamins", "ibuprofen", "acetaminophen", "allergy", "bandages", "first aid", "cold medicine", "antacid"],
};

const CONFIDENT = 0.9;
const AMBIGUOUS = 0.5;
const HINT_ONLY = 0.4;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function compile(dict: Record<string, string[]>) {
  return Object.entries(dict).map(([category, words]) => ({
    category,
    patterns: words.map((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w)}($|[^a-z0-9])`, "i")),
  }));
}

const RESTRICTED_RX = compile(RESTRICTED);
const GENERAL_RX = compile(GENERAL);

function hits(text: string, rx: ReturnType<typeof compile>) {
  return rx
    .map((c) => ({ category: c.category, count: c.patterns.filter((p) => p.test(text)).length }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * Deterministic keyword classifier. Pure. The agent's category hint is only trusted when it
 * agrees with the rules; on its own it yields a low-confidence result (→ human approval).
 */
export function classifyItemByRules(item: CartItem, index: number): ItemClassification {
  let urlText = "";
  if (item.url) {
    try {
      urlText = decodeURIComponent(new URL(item.url).pathname).replace(/[-_/+]+/g, " ");
    } catch {
      urlText = "";
    }
  }
  const text = `${item.name} ${urlText}`.toLowerCase();
  const hint = item.category_hint;

  const restricted = hits(text, RESTRICTED_RX);
  if (restricted[0]) {
    return { index, category: restricted[0].category, confidence: CONFIDENT, source: "rules", note: "matched restricted keyword" };
  }
  if (hint && RESTRICTED[hint]) {
    // The agent itself says this is restricted. Believe it.
    return { index, category: hint, confidence: CONFIDENT, source: "agent_hint", note: "agent labelled item as restricted" };
  }

  const general = hits(text, GENERAL_RX);
  const [top, second] = general;
  if (top) {
    if (hint && general.some((g) => g.category === hint)) {
      return { index, category: hint, confidence: 0.95, source: "rules", note: "rules agree with agent hint" };
    }
    if (second && second.count === top.count) {
      return { index, category: top.category, confidence: AMBIGUOUS, source: "rules", note: `ambiguous: ${top.category} or ${second.category}` };
    }
    if (hint && hint !== top.category) {
      return { index, category: top.category, confidence: AMBIGUOUS, source: "rules", note: `rules say ${top.category}, agent says ${hint}` };
    }
    return { index, category: top.category, confidence: second ? 0.75 : CONFIDENT, source: "rules" };
  }
  if (hint) return { index, category: hint, confidence: HINT_ONLY, source: "agent_hint", note: "only the agent's unverified label" };
  return { index, category: UNCERTAIN_CATEGORY, confidence: 0, source: "none", note: "could not classify" };
}

export class RuleBasedClassifier implements ItemClassifier {
  async classify(items: CartItem[], _ctx: ClassifierContext): Promise<ItemClassification[]> {
    return items.map((item, i) => classifyItemByRules(item, i));
  }
}

/**
 * Rules first; items the rules are unsure about go to an optional secondary classifier
 * (e.g. an LLM). Restricted-category rule hits are never overridden.
 */
export class CompositeClassifier implements ItemClassifier {
  constructor(
    private readonly fallback: ItemClassifier,
    private readonly threshold = 0.7,
  ) {}

  async classify(items: CartItem[], ctx: ClassifierContext): Promise<ItemClassification[]> {
    const base = items.map((item, i) => classifyItemByRules(item, i));
    const unsure = base.filter((c) => c.confidence < this.threshold);
    if (!unsure.length) return base;
    let second: ItemClassification[] = [];
    try {
      second = await this.fallback.classify(unsure.map((c) => items[c.index]!), ctx);
    } catch {
      return base; // fallback failure keeps the low-confidence result → approval
    }
    return base.map((c) => {
      const j = unsure.indexOf(c);
      const alt = j >= 0 ? second[j] : undefined;
      return alt && alt.confidence > c.confidence ? { ...alt, index: c.index } : c;
    });
  }
}
