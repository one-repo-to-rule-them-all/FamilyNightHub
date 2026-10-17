import type { Metadata } from "next";

import { DevicesAdmin } from "./devices-admin";

export const metadata: Metadata = { title: "Phones and TVs" };

/** Phones and TVs: list, label, revoke (`admin:devices`; revocation is final, 03-backend.md). */
export default function AdminDevicesPage() {
  return <DevicesAdmin />;
}
