import { Clapperboard } from "lucide-react";

import { RatePromptCard } from "@/components/night/rate-prompt-card";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <Clapperboard aria-hidden className="size-14 text-cinema" />
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Family Night Hub</h1>
      <p className="text-lg text-muted-foreground">
        Scan the QR code on the fridge or the TV to join tonight&apos;s movie night.
      </p>
      {/* A phone that has joined before is asked about its last night here. */}
      <RatePromptCard />
    </main>
  );
}
