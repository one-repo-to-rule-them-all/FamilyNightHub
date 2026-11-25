import type { Metadata } from "next";

import { GameRoute } from "./game-route";

export const metadata: Metadata = { title: "Game" };

export default async function GamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <GameRoute gameId={game} />;
}
