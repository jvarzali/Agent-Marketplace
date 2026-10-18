import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate: no session cookie means not signed in, so go to /login and come back after.
// The dashboard layout does the real session check against the database.
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function middleware(req: NextRequest) {
  if (SESSION_COOKIES.some((c) => req.cookies.has(c))) return NextResponse.next();
  // Server Actions check the session themselves and tell the client to go sign in.
  if (req.headers.has("next-action")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const back = req.nextUrl.pathname + req.nextUrl.search;
  if (back !== "/") url.searchParams.set("callbackUrl", back);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the login page, the test store (/shop), API routes (agents, webhooks, Auth.js), Next internals and static files.
  matcher: ["/((?!login|demo-store|shop|api/|_next/|sw\\.js|favicon\\.ico|.*\\.(?:png|svg|ico|webmanifest)$).*)"],
};
