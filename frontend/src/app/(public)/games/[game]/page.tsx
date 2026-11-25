import type { Metadata } from "next";

import { JarScreen } from "./jar-screen";

export const metadata: Metadata = { title: "Game" };

export default async function GamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <JarScreen gameId={game} />;
}
