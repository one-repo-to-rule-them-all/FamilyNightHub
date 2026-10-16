import type { Metadata } from "next";

import { SettingsAdmin } from "./settings-admin";

export const metadata: Metadata = { title: "Settings" };

/** Join link rotation, defaults and streaming services (`admin:settings`, 03-backend.md). */
export default function AdminSettingsPage() {
  return <SettingsAdmin />;
}
