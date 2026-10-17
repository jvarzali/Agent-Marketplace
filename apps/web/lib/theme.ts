"use client";

import { useCallback, useEffect, useState } from "react";

// Appearance is a per-browser preference, so it lives in localStorage rather
// than the demo store. "system" leaves <html> without data-theme and the CSS
// follows prefers-color-scheme.
export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "agentmart.theme";

/** Runs in <head> before first paint so a saved theme never flashes the other one. */
export const themeBootScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // Storage blocked: fall back to the system setting.
  }
  return "system";
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    setPref(readPref());
  }, []);

  const set = useCallback((p: ThemePref) => {
    setPref(p);
    const root = document.documentElement;
    if (p === "system") delete root.dataset.theme;
    else root.dataset.theme = p;
    try {
      if (p === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, p);
    } catch {
      // Non-fatal: the choice just won't survive a reload.
    }
  }, []);

  return [pref, set];
}
