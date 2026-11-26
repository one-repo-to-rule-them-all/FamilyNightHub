import type { Metadata } from "next";

import { NightAlbumScreen } from "./night-album-screen";

export const metadata: Metadata = { title: "Photos" };

export default async function NightAlbumPage({ params }: { params: Promise<{ album: string }> }) {
  const { album } = await params;
  return <NightAlbumScreen albumId={album === "tonight" ? null : album} />;
}
