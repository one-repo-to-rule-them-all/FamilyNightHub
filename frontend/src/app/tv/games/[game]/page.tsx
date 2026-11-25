import { TvGameRoute } from "./game-route";

export default async function TvGamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <TvGameRoute gameId={game} />;
}
