import type { Metadata } from "next";

import { GamesAdmin } from "./games-admin";

export const metadata: Metadata = { title: "Games" };

/** Games (ADR-0018): start a game and run it. Inside the portal shell (host layout). */
export default function HostGamesPage() {
  return (
    <div className="mx-auto w-full max-w-2xl lg:mx-0">
      <GamesAdmin />
    </div>
  );
}
