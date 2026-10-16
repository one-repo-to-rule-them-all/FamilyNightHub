import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { JoinForm } from "./join-form";

export const metadata: Metadata = { title: "Join tonight" };

export default async function JoinPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <PhoneScreen title="Join movie night" lede="Type the code you see on the TV.">
      <JoinForm slug={slug} />
    </PhoneScreen>
  );
}
