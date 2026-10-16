import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { HostHome } from "./host-home";

export const metadata: Metadata = { title: "Host" };

/** Start a night, approve phones, pair the TV (04-frontend.md route table). */
export default function HostPage() {
  return (
    <PhoneScreen title="Host">
      <HostHome />
    </PhoneScreen>
  );
}
