import type { Metadata } from "next";

import { GameScreen } from "./game-screen";

export const metadata: Metadata = { title: "Game" };

export default async function GamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <GameScreen gameId={game} />;
}
