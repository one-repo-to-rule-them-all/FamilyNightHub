import type { Metadata } from "next";

import { PeopleAdmin } from "./people-admin";

export const metadata: Metadata = { title: "People" };

/** Add, rename/re-avatar, guest → member, merge (`admin:people`, 03-backend.md). */
export default function AdminPeoplePage() {
  return <PeopleAdmin />;
}
