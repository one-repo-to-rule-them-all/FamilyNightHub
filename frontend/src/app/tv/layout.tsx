import type { Metadata } from "next";

import { FullscreenButton } from "./fullscreen-button";
import "./tv.css";

export const metadata: Metadata = { title: "TV" };

/**
 * The paired living-room TV (04-frontend.md route table): full screen, large type. Exactly one
 * viewport tall: every state lays out inside it rather than scrolling (issue #90).
 */
export default function TvLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="tv-screen flex h-dvh min-h-0 flex-col overflow-hidden px-[2.5em] py-[2em]">
      {children}
      <FullscreenButton />
    </main>
  );
}
