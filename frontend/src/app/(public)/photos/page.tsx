import type { Metadata } from "next";

import { AlbumsScreen } from "./albums-screen";

export const metadata: Metadata = { title: "Photos" };

export default function AlbumsPage() {
  return <AlbumsScreen />;
}
