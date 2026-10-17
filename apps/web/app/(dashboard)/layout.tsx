import { getWallet } from "@agent-wallet/core";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/AppShell";
import { toSnapshot } from "@/lib/server/snapshot";
import { StoreProvider } from "@/lib/store";

// Per-user data on every request.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  // middleware.ts sends signed-out visitors to /login with a callback; this catches stale cookies.
  if (!session?.user?.id) redirect("/login");
  const initial = toSnapshot(await getWallet().owner.getDashboardSnapshot(session.user.id));
  return (
    <StoreProvider initial={initial}>
      <AppShell vapidPublicKey={process.env.VAPID_PUBLIC_KEY || null}>{children}</AppShell>
    </StoreProvider>
  );
}
