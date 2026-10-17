"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Facts, LedgerHead } from "@/components/bits";
import { PushToggle } from "@/components/PushToggle";
import { signOutAction } from "@/lib/actions";
import { useStore } from "@/lib/store";
import { type ThemePref, useTheme } from "@/lib/theme";

const THEMES: { id: ThemePref; label: string; Icon: typeof Sun }[] = [
  { id: "system", label: "Match my device", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
];

export function SettingsView({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const store = useStore();
  const [theme, setTheme] = useTheme();

  return (
    <div className="page page--narrow">
      <header className="pagetitle">
        <h1>Settings</h1>
        <p className="pagetitle__meta">Preferences for this browser and your account.</p>
      </header>

      <section className="ledger" aria-labelledby="appearance">
        <LedgerHead id="appearance" title="Appearance" />
        <fieldset className="fs fs--bare">
          <legend>Theme</legend>
          <div className="choice">
            {THEMES.map((t) => (
              <label key={t.id} className="radio">
                <input type="radio" name="theme" checked={theme === t.id} onChange={() => setTheme(t.id)} />
                <t.Icon size={16} aria-hidden="true" />
                {t.label}
              </label>
            ))}
          </div>
          <p className="fine">Saved on this device. Receipts keep their paper colors in either theme.</p>
        </fieldset>
      </section>

      <section className="ledger" aria-labelledby="account">
        <LedgerHead id="account" title="Account" />
        <Facts
          rows={[
            { label: "Email", text: store.userEmail },
            {
              label: "Notifications",
              text: vapidPublicKey ? (
                <PushToggle vapidPublicKey={vapidPublicKey} />
              ) : (
                "Approval requests arrive by email. Push isn’t set up on this server."
              ),
            },
          ]}
        />
        <form action={signOutAction}>
          <button className="btn btn--sm" type="submit">
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}
