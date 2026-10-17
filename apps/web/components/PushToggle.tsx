"use client";

import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { deletePushSubscription, savePushSubscription } from "@/lib/actions";

type State = "unsupported" | "off" | "on" | "blocked" | "working";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Turns approval push notifications on or off for this browser. Tapping one opens the request; it never approves. */
export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [state, setState] = useState<State>("working");

  useEffect(() => {
    if (!vapidPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("unsupported"));
  }, [vapidPublicKey]);

  if (state === "unsupported") return null;

  const turnOn = async () => {
    setState("working");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey!) });
      const json = sub.toJSON();
      const r = await savePushSubscription({ endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } });
      if (!r.ok) {
        await sub.unsubscribe();
        setState("off");
        return;
      }
      setState("on");
    } catch {
      setState(Notification.permission === "denied" ? "blocked" : "off");
    }
  };

  const turnOff = async () => {
    setState("working");
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) {
      await deletePushSubscription(sub.endpoint);
      await sub.unsubscribe();
    }
    setState("off");
  };

  if (state === "blocked") return <span className="fine">Notifications blocked in browser settings</span>;
  return state === "on" ? (
    <button className="linkbtn" onClick={turnOff} title="Stop push notifications on this device">
      <BellOff size={14} aria-hidden="true" /> Notifications on
    </button>
  ) : (
    <button className="linkbtn" onClick={turnOn} disabled={state === "working"} title="Get a push notification when an agent asks">
      <Bell size={14} aria-hidden="true" /> Notify me
    </button>
  );
}
