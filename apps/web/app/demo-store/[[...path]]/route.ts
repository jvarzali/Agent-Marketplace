// The test store moved to /shop (so its URL doesn't tell agents it's a test store).
// Next.js rewrites req.url's host to localhost; keep the one the browser used (shop.localhost).
export function GET(req: Request) {
  const url = new URL(req.url);
  const host = req.headers.get("host");
  if (host) url.host = host;
  url.pathname = url.pathname.replace(/^\/demo-store/, "/shop");
  return Response.redirect(url, 308);
}
