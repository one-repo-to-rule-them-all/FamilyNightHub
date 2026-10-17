import { PortalShell } from "@/components/portal/portal-shell";

/**
 * The admin half of the owner portal (proposals/owner-portal.md §3): People, Phones, Library,
 * History, Settings inside the one `PortalShell` that also wraps `/host`. proxy.ts sends a browser
 * with no `fnh_session` to /login; the API enforces the `admin:*` permissions, and a host who
 * types an admin URL gets that screen's 403 as an "Admins only" panel.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
