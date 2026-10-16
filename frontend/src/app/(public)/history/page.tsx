import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { HistoryList } from "./history-list";

export const metadata: Metadata = { title: "Past movie nights" };

export default function HistoryPage() {
  return (
    <PhoneScreen title="Past movie nights" lede="What we picked, and how many of us voted.">
      <HistoryList />
    </PhoneScreen>
  );
}
