"use client";

import { ChevronLeft, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Avatar } from "@/components/night/avatar";
import { SwitchSheet } from "@/components/night/switch-sheet";
import type { PersonTile } from "@/lib/api";
import { HOME_COPY } from "@/lib/home";

/**
 * The guest app bar (guest-home §5 H0): an optional ‹ back link, the household's name (or
 * "Family Night" until this phone knows it, G11) and the current person as a button that opens the
 * existing switch sheet (PIN on every switch, ADR-0014).
 */
export function AppBar({
  householdName,
  back,
  people,
  current,
}: {
  householdName: string | null;
  back?: { href: string; label: string };
  people?: PersonTile[];
  current: PersonTile | null;
}) {
  const [switching, setSwitching] = useState(false);
  return (
    <header
      data-testid="app-bar"
      className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-foreground/10 bg-background/95 px-3 backdrop-blur"
    >
      {back ? (
        <Link
          href={back.href}
          data-testid="app-bar-back"
          className="flex h-14 shrink-0 items-center gap-0.5 pr-1 text-base text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronLeft aria-hidden className="size-5" />
          {back.label}
        </Link>
      ) : null}
      <span
        data-testid="household-name"
        className="min-w-0 flex-1 truncate font-heading text-lg font-semibold"
      >
        {householdName ?? HOME_COPY.bar.fallback}
      </span>
      {current && people ? (
        <button
          type="button"
          aria-label={HOME_COPY.bar.switch(current.name)}
          aria-haspopup="dialog"
          data-testid="app-bar-person"
          onClick={() => setSwitching(true)}
          className="flex h-11 max-w-[50%] shrink-0 items-center gap-2 rounded-full bg-card py-1 pr-3 pl-1 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <Avatar emoji={current.avatar_emoji} color={current.color} className="size-9 text-xl" />
          <span className="truncate text-base font-medium">{current.name}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
      {switching && current && people ? (
        <SwitchSheet people={people} current={current} onClose={() => setSwitching(false)} />
      ) : null}
    </header>
  );
}
