import path from "node:path";
import { config } from "dotenv";

// One .env for the whole monorepo: load the root file into the server process before any
// request is handled. Variables already set (e.g. by the host, or apps/web/.env*) win.
config({ path: path.join(process.cwd(), "../../.env"), quiet: true });
