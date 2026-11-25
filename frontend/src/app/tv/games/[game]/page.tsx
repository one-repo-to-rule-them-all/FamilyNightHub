import { TvJar } from "./tv-jar";

export default async function TvGamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <TvJar gameId={game} />;
}
