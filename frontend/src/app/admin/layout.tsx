import type { Metadata } from "next";

import { AdminGuard, AdminNav } from "./admin-shell";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" } };

/** The admin area: wider than the phone column, denser tables (04-frontend.md route table). */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-5 py-8">
      <AdminNav />
      <AdminGuard>{children}</AdminGuard>
    </main>
  );
}
