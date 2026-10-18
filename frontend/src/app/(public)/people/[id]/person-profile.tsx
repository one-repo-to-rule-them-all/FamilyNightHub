"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { GuestShell } from "@/components/home/guest-shell";
import { usePhonePeople } from "@/hooks/use-phone";
import { HOME_COPY } from "@/lib/home";

import { ProfileView } from "./profile-view";

/**
 * H5 a person's profile (guest-home §5 H5): the unchanged profile inside the guest shell with a ‹
 * back link. Reached from History, Here tonight and Me (`?from=me`, so ‹ goes back there). Your own
 * id goes to `/me`, which has your controls.
 */
export function PersonProfile({ personId }: { personId: string }) {
  const router = useRouter();
  const fromMe = useSearchParams().get("from") === "me";
  const { current } = usePhonePeople();
  const own = current?.id === personId;

  useEffect(() => {
    if (own) router.replace("/me");
  }, [own, router]);

  return (
    <GuestShell
      screen="profile"
      back={
        fromMe
          ? { href: "/me", label: HOME_COPY.nav.me }
          : { href: "/history?tab=family", label: HOME_COPY.nav.history }
      }
    >
      {own ? null : <ProfileView personId={personId} />}
    </GuestShell>
  );
}
