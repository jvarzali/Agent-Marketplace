// Agent-facing endpoints from @paysafe/api: REST (/api/v1/*), remote MCP (/api/mcp),
// card issuer webhooks (/api/webhooks/issuer) and the expiry sweep (/api/cron/expire).
// /api/auth/* is handled by its own, more specific route.
import { createApiHandler } from "@paysafe/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = createApiHandler();
export { handle as GET, handle as POST, handle as DELETE };
