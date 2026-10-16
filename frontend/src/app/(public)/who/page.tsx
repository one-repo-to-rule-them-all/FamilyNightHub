import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { WhoGrid } from "./who-grid";

export const metadata: Metadata = { title: "Who are you?" };

export default function WhoPage() {
  return (
    <PhoneScreen
      title="Who are you?"
      lede="Tap your picture. Sharing a phone? Tap everyone using it."
    >
      <WhoGrid />
    </PhoneScreen>
  );
}
