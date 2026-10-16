import type { Metadata } from "next";

import { AlbumScreen } from "./album-screen";

export const metadata: Metadata = { title: "Photos" };

export default async function AlbumPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return <AlbumScreen sessionId={session} />;
}
