import type { Metadata } from "next";

import { NightScreen } from "./night-screen";

export const metadata: Metadata = { title: "Movie night" };

export default async function NightPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return <NightScreen sessionId={session} />;
}
