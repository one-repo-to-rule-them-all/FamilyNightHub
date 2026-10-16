import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { NightBuilder } from "./night-builder";

export const metadata: Metadata = { title: "Tonight" };

export default async function HostNightPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return (
    <PhoneScreen title="Tonight" className="max-w-2xl">
      <NightBuilder sessionId={session} />
    </PhoneScreen>
  );
}
