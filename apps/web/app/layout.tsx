import type { Metadata, Viewport } from "next";
import { Inter, Spline_Sans_Mono } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import { StoreProvider } from "@/lib/store";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-receipt", display: "swap" });

export const metadata: Metadata = {
  title: { default: "AgentMart", template: "%s | AgentMart" },
  description: "Set what your AI agents can buy, approve purchases, and freeze spending instantly.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The boot script may set data-theme before React hydrates.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <StoreProvider>
          <AppShell>{children}</AppShell>
        </StoreProvider>
      </body>
    </html>
  );
}
