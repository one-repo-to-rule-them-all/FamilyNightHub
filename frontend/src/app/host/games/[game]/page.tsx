import type { Metadata } from "next";

import { HostGameRoute } from "./game-route";

export const metadata: Metadata = { title: "Run a game" };

export default async function HostGamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return (
    <div className="mx-auto w-full max-w-2xl lg:mx-0">
      <HostGameRoute gameId={game} />
    </div>
  );
}
