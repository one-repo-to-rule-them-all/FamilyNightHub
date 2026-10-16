import type { Metadata } from "next";

import { AdminShell } from "./admin-shell";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" } };

/**
 * The admin area (04-frontend.md "Admin"): signed-in admins. proxy.ts sends a browser with no
 * `fnh_session` to /login; the API enforces the `admin:*` permissions, and a host gets each
 * screen's 403 as an "admins only" panel.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
