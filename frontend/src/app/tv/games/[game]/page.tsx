import { TvGame } from "./tv-game";

export default async function TvGamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <TvGame gameId={game} />;
}
