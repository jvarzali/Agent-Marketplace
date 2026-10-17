import type { Metadata } from "next";
import { SettingsView } from "@/components/views/SettingsView";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <SettingsView vapidPublicKey={process.env.VAPID_PUBLIC_KEY || null} />;
}
