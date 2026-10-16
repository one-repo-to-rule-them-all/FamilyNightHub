import type { Metadata } from "next";

import "./tv.css";

export const metadata: Metadata = { title: "TV" };

/** The paired living-room TV (04-frontend.md route table): full screen, large type. */
export default function TvLayout({ children }: { children: React.ReactNode }) {
  return <main className="tv-screen flex min-h-dvh flex-1 flex-col p-[2.5em]">{children}</main>;
}
