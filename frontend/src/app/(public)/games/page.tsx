import type { Metadata } from "next";

import { GamesScreen } from "./games-screen";

export const metadata: Metadata = { title: "Games" };

export default function GamesPage() {
  return <GamesScreen />;
}
