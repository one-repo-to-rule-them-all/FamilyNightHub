import { PortalShell } from "@/components/portal/portal-shell";

/**
 * Home and the night being run (`/host`, `/host/[session]`) inside the owner portal's shell
 * (proposals/owner-portal.md §3). Signed-in admins and hosts; proxy.ts sends anyone else to /login.
 */
export default function HostLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
