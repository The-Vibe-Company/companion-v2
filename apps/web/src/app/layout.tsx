import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Companion · Skills",
  description: "A versioned registry of SKILL.md packages.",
  icons: {
    icon: "/brand/favicon.png",
    apple: "/brand/apple-icon.png",
  },
};

// Set data-theme / data-accent on <html> before paint to avoid a theme flash.
// Mirrors lib/theme.ts (localStorage key "sx_prefs"; light + yellow are the
// no-attribute defaults; "system" resolves via prefers-color-scheme).
const NO_FOUC_SCRIPT = `(function(){try{var r=document.documentElement;var p={theme:"light",accent:"yellow"};try{var s=localStorage.getItem("sx_prefs");if(s){var o=JSON.parse(s);if(o){if(o.theme)p.theme=o.theme;if(o.accent)p.accent=o.accent;}}}catch(e){}var t=p.theme;if(t==="system")t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(t==="dark")r.setAttribute("data-theme","dark");else r.removeAttribute("data-theme");if(p.accent&&p.accent!=="yellow")r.setAttribute("data-accent",p.accent);else r.removeAttribute("data-accent");}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the NO_FOUC_SCRIPT below sets data-theme/data-accent
    // on <html> before hydration, so the client <html> attributes intentionally
    // differ from the server-rendered ones. This suppresses only this element's attrs.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* First in <body> so it runs before paint; kept out of <head> to avoid
            hydration mismatch when the host injects its own import map there. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FOUC_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
