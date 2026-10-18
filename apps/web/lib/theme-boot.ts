// Server-safe half of the theme preference (no "use client"), so the root layout can inline
// the boot script as a plain string. The hook lives in theme.ts.

export const THEME_KEY = "paysafe.theme";

/** Runs in <head> before first paint so a saved theme never flashes the other one. */
export const themeBootScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
