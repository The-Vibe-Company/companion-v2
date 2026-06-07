import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Companion · Skills",
  description: "A versioned registry of SKILL.md packages.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
