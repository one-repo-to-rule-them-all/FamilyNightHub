import type { Metadata } from "next";

import { SettingsAdmin } from "./settings-admin";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings, in groups (proposals/owner-portal.md §5 P5). Admins: Joining, Movie nights, Streaming
 * (`admin:settings`, 03-backend.md), Your account, This browser. Hosts: the last two only.
 */
export default function AdminSettingsPage() {
  return <SettingsAdmin />;
}
