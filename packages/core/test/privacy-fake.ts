import { randomUUID } from "node:crypto";

/** In-memory stand-in for the Privacy.com card API (POST/GET/PATCH /cards), for tests. */
export function fakePrivacyApi() {
  const cards = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if ((init?.headers as Record<string, string>)?.["authorization"] !== "api-key test_privacy_key") return json(401, { message: "bad key" });
    const m = /^\/v1\/cards(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return json(404, { message: "not found" });
    const token = m[1];
    if (method === "POST" && !token) {
      n++;
      const t = randomUUID();
      const pan = `41111112891${String(40000 + n).padStart(5, "0")}`;
      const card = { token: t, last_four: pan.slice(-4), state: body.state ?? "OPEN", type: body.type, spend_limit: body.spend_limit, spend_limit_duration: body.spend_limit_duration, memo: body.memo, pan, cvv: "776", exp_month: "06", exp_year: "2030" };
      cards.set(t, card);
      return json(200, card);
    }
    const card = token ? cards.get(token) : undefined;
    if (!card) return json(404, { message: "card not found" });
    if (method === "GET") return json(200, card);
    if (method === "PATCH") {
      if (card.state === "CLOSED") return json(400, { message: "card is closed" });
      Object.assign(card, body);
      return json(200, card);
    }
    return json(405, { message: "method" });
  }) as typeof fetch;
  return { fetch: fetchImpl, cards, calls };
}

export function privacyTxn(o: { token: string; card: string; type: "AUTHORIZATION" | "CLEARING" | "RETURN" | "VOID"; amount: number; descriptor: string; mcc?: string; result?: string; eventToken?: string }) {
  return {
    token: o.token,
    card_token: o.card,
    amount: o.type === "RETURN" ? -o.amount : o.amount,
    authorization_amount: o.amount,
    result: o.result ?? "APPROVED",
    status: o.type === "CLEARING" ? "SETTLING" : o.type === "VOID" ? "VOIDED" : "PENDING",
    merchant: { acceptor_id: "174030075991", city: "NEW YORK", country: "USA", descriptor: o.descriptor, mcc: o.mcc ?? "5411", state: "NY" },
    events: [{ token: o.eventToken ?? `${o.token}-${o.type}`, type: o.type, result: o.result ?? "APPROVED", amount: o.amount, created: "2026-10-14T19:05:00Z" }],
  };
}
