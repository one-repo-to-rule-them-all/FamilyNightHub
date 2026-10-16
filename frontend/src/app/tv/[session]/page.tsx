import { TvNight } from "./tv-night";

export default async function TvNightPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return <TvNight sessionId={session} />;
}
