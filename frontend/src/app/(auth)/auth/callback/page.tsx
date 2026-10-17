import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { VerifyLink } from "./verify-link";

// The one-time token is in the URL: never leak it to another origin through Referer.
export const metadata: Metadata = { title: "New password", referrer: "no-referrer" };

export default async function CallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return (
    <PhoneScreen title="Choose a new password">
      <VerifyLink token={typeof token === "string" && token ? token : null} />
    </PhoneScreen>
  );
}
