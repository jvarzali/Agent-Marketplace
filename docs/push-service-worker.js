/* Agent Wallet push service worker. Serve as /sw.js from the web app.
 * Payload (from @agent-wallet/core WebPushSender): { title, body, url, tag, actions }.
 * Approve/Deny buttons only OPEN the confirmation page; nothing is decided from a notification.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Agent Wallet", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Agent Wallet", {
      body: data.body || "",
      tag: data.tag,
      data: { url: data.url || "/" },
      actions: data.actions || [],
      requireInteraction: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const base = new URL(event.notification.data?.url || "/", self.location.origin);
  // Only ever navigate within our own origin.
  if (base.origin !== self.location.origin) return;
  if (event.action === "approve" || event.action === "deny") base.searchParams.set("intent", event.action);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          w.navigate(base.href);
          return w.focus();
        }
      }
      return self.clients.openWindow(base.href);
    }),
  );
});
