import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { VerifyLink } from "./verify-link";

// The one-time token is in the URL: never leak it to another origin through Referer.
export const metadata: Metadata = { title: "New password", referrer: "no-referrer" };

export default async function CallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; invite?: string | string[] }>;
}) {
  const { token, invite } = await searchParams;
  // An invite (issue #71) is the same single-use link; only the words differ.
  const invited = invite === "1";
  return (
    <PhoneScreen title={invited ? "Welcome to Family Night" : "Choose a new password"}>
      <VerifyLink token={typeof token === "string" && token ? token : null} invited={invited} />
    </PhoneScreen>
  );
}
