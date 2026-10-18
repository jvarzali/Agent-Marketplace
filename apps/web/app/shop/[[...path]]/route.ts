// Test store for trying the full agent flow with test cards (mock issuer or Stripe test mode).
// Open it at http://shop.localhost:3000/shop. See packages/api/src/demo-store.ts.
import { createDemoStoreHandler } from "@agent-wallet/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = createDemoStoreHandler();
export { handle as GET, handle as POST };
