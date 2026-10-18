import path from "node:path";
import { config } from "dotenv";

// One .env for the whole monorepo: load the root file into the server process before any
// request is handled. Variables already set (e.g. by the host, or apps/web/.env*) win.
config({ path: path.join(process.cwd(), "../../.env"), quiet: true });

// Expiry sweep: lapses stale approvals and closes unused cards (30 minutes). Real cards like
// Privacy's stay open until we close them, so this must run. In-process every minute unless
// EXPIRY_SWEEP=off (e.g. on serverless hosts, where a scheduler calls /api/cron/expire instead).
const g = globalThis as unknown as { __expirySweep?: ReturnType<typeof setInterval> };
if (process.env.EXPIRY_SWEEP !== "off" && !g.__expirySweep) {
  g.__expirySweep = setInterval(() => {
    import("@paysafe/core")
      .then(({ getWallet }) => getWallet().expireStale())
      .catch((e) => console.error("expiry sweep failed", e instanceof Error ? e.message : e));
  }, 60_000);
  g.__expirySweep.unref?.();
}
