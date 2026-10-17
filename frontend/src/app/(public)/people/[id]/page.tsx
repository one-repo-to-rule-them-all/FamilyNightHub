import type { Metadata } from "next";

import { ProfileView } from "./profile-view";

export const metadata: Metadata = { title: "Profile" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProfileView personId={id} />;
}
