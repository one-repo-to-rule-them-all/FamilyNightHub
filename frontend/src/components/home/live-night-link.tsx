"use client";

import { ChevronRight, Clapperboard } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { markNightSeen } from "@/hooks/use-household-night";
import type { NightSummary } from "@/lib/api";
import { handoffLine, HOME_COPY, nightHref } from "@/lib/home";
import { cn } from "@/lib/utils";

/**
 * The small inline link to tonight's night on That's a wrap and the recap (guest-home §5 H3w,
 * H3r). The new-night toast (H0c) does the announcing and the countdown; this stays after the toast
 * is gone (Stay here, or a phone that came back), so the past night still points at the live one.
 * On That's a wrap it is the screen's one primary while a newer night is live.
 */
export function LiveNightLink({
  night,
  primary,
}: {
  night: Pick<NightSummary, "id" | "status">;
  primary: boolean;
}) {
  return (
    <Link
      href={nightHref(night.id)}
      onClick={() => markNightSeen(night.id)}
      data-testid={primary ? "primary-action" : "live-night-link"}
      data-live-link
      data-night={night.id}
      aria-label={`${handoffLine(night.status)} ${HOME_COPY.handoff.go}`}
      className={cn(
        buttonVariants({ variant: primary ? "default" : "secondary", size: "tap" }),
        "w-full justify-between",
      )}
    >
      <span className="flex items-center gap-2">
        <Clapperboard aria-hidden />
        {HOME_COPY.handoff.go}
      </span>
      <ChevronRight aria-hidden />
    </Link>
  );
}
