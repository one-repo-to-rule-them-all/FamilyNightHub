import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { Providers } from "./providers";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Family Night Hub", template: "%s · Family Night Hub" },
  description: "Plan and enjoy family nights together.",
  applicationName: "Family Night Hub",
};

export const viewport: Viewport = {
  themeColor: "#121110",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

// Dark only in v1 (04-frontend.md). The `dark` class drives the primitives' `dark:` variants.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
