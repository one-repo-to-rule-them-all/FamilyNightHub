"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLiveSession } from "@/hooks/use-live-session";
import { useVoters } from "@/hooks/use-voters";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { api, type ApiError, type Night, type Person } from "@/lib/api";
import { joinUrl, qrShape } from "@/lib/join-link";
import {
  forgetNightCode,
  nightCodeIsLive,
  recallNightCode,
  rememberNightCode,
} from "@/lib/night-code-handoff";
import { cleanNightCodeInput, completeNightCode } from "@/lib/night-code";
import { cn } from "@/lib/utils";

import { useCurrentNight } from "../tv-home";
import { Reveal } from "./reveal";

/**
 * No endpoint exposes the household's join slug to a device (or to a host) yet, so the TV can't
 * build the /j/{slug} QR itself; it points people at the fridge QR instead. See the PR notes and
 * 04-frontend.md "TV".
 */
const JOIN_SLUG: string | null = null;

/** /tv/[session]: lobby → turnout → reveal, pushed live (polling only while the stream is down). */
export function TvNight({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const night = useLiveSession(sessionId);
  const { live } = night;
  const status = night.data?.status;
  const people = useQuery<Person[], ApiError>({
    queryKey: ["people"],
    queryFn: api.people,
    refetchInterval: 30_000,
  });
  const voters = useVoters(sessionId, status === "voting", live);
  const current = useCurrentNight();
  useWakeLock();

  // Tonight is over (or another night started): follow the newest night on screen.
  const nextId = current.data?.id;
  useEffect(() => {
    if (nextId && nextId !== sessionId && (status === "closed" || status === "tonight")) {
      router.replace(`/tv/${nextId}`);
    }
  }, [nextId, sessionId, status, router]);

  useEffect(() => {
    if (status && !nightCodeIsLive(status)) forgetNightCode(sessionId);
  }, [status, sessionId]);

  if (night.error?.status === 401) {
    return (
      <p className="tv-title m-auto text-center" data-testid="tv-unpaired">
        This screen isn&apos;t paired. A host can pair it from the host page.
      </p>
    );
  }
  if (!night.data) {
    return (
      <p className="tv-body m-auto text-muted-foreground" data-live={live}>
        {night.isError ? night.error.message : "Loading…"}
      </p>
    );
  }

  const data = night.data;
  const votedIds = new Set((voters.data ?? []).map((v) => v.person_id));

  return (
    <div className="flex flex-1 flex-col gap-[2em]" data-live={live} data-status={data.status}>
      <header className="flex items-baseline justify-between gap-[1em]">
        <h1 className="tv-title">{data.title || "Movie night"}</h1>
        {live === "reconnecting" ? (
          <p className="tv-body text-muted-foreground" role="status" data-testid="tv-live-status">
            Reconnecting…
          </p>
        ) : null}
      </header>

      {data.status === "draft" || data.status === "voting" ? (
        <div className="grid flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-[2.5em]">
          <JoinPanel sessionId={data.id} />
          <div className="flex flex-col gap-[1.5em]">
            <Headline night={data} voted={votedIds.size} total={people.data?.length ?? 0} />
            <Turnout
              people={people.data ?? []}
              voted={votedIds}
              voting={data.status === "voting"}
            />
          </div>
        </div>
      ) : null}

      {data.result ? <Reveal night={data} animate={data.status === "revealed"} /> : null}
    </div>
  );
}

function Headline({ night, voted, total }: { night: Night; voted: number; total: number }) {
  if (night.status === "draft") {
    const n = night.options.length;
    return (
      <div className="flex flex-col gap-[0.5em]">
        <p className="tv-display">Get comfy</p>
        <p className="tv-body text-muted-foreground" data-testid="tv-headline">
          The host is picking the shortlist{n > 0 ? ` (${n} so far)` : ""}. Join now so you&apos;re
          ready to vote.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[0.5em]">
      <p className="tv-display">Vote on your phone</p>
      <p className="tv-body text-muted-foreground" data-testid="tv-headline" aria-live="polite">
        {voted} of {total} voted
      </p>
    </div>
  );
}

/** Turnout tiles: one per person, lit once their ballot is in. Never what they picked. */
function Turnout({
  people,
  voted,
  voting,
}: {
  people: Person[];
  voted: Set<string>;
  voting: boolean;
}) {
  return (
    <ul
      className="grid grid-cols-[repeat(auto-fill,minmax(7.5em,1fr))] gap-[1em]"
      aria-label="Turnout"
    >
      {people.map((person) => {
        const done = voting && voted.has(person.id);
        return (
          <li
            key={person.id}
            data-testid="tv-tile"
            data-person={person.name}
            data-voted={done}
            aria-label={done ? `${person.name} has voted` : person.name}
            className={cn(
              "tv-tile relative flex flex-col items-center gap-[0.4em] rounded-2xl bg-card p-[0.8em] ring-1 ring-foreground/10",
              voting && !done && "opacity-45",
              done && "marquee-glow",
            )}
          >
            <Avatar
              emoji={person.avatar_emoji}
              color={person.color}
              className="size-[3.6em] text-[2.2em]"
            />
            <span aria-hidden className="tv-body leading-tight">
              {person.name}
            </span>
            {done ? (
              <Check
                aria-hidden
                className="absolute top-[0.4em] right-[0.4em] size-[1.4em] text-cinema"
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function JoinPanel({ sessionId }: { sessionId: string }) {
  const [code, setCode] = useState<string | null>(() => recallNightCode(sessionId));

  return (
    <section
      aria-labelledby="tv-join"
      className="flex flex-col items-center justify-center gap-[1.2em] rounded-3xl bg-card p-[1.5em] text-center ring-1 ring-foreground/10"
    >
      <h2 id="tv-join" className="tv-body text-muted-foreground">
        {JOIN_SLUG ? "Scan to join" : "Scan the fridge QR to join"}
      </h2>
      {JOIN_SLUG ? <JoinQr url={joinUrl(window.location.origin, JOIN_SLUG)} /> : null}
      {code ? (
        <>
          <p className="tv-body text-muted-foreground">then enter</p>
          <p className="tv-code font-mono" data-testid="tv-night-code">
            {code}
          </p>
        </>
      ) : (
        <CodeEntry
          onCode={(value) => {
            rememberNightCode(sessionId, value);
            setCode(value);
          }}
        />
      )}
    </section>
  );
}

/**
 * A TV paired on an earlier night never saw tonight's code (the server can't give it back).
 * The host types it once from their phone; it stays in this tab only.
 */
function CodeEntry({ onCode }: { onCode: (code: string) => void }) {
  const [value, setValue] = useState("");
  const complete = completeNightCode(value);
  return (
    <form
      className="flex w-full flex-col gap-[0.6em]"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) onCode(complete);
      }}
    >
      <Label htmlFor="tv-code-entry" className="tv-body justify-center">
        Host: type tonight&apos;s code to show it here
      </Label>
      <Input
        id="tv-code-entry"
        value={value}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        onChange={(event) => setValue(cleanNightCodeInput(event.target.value))}
        className="tv-body h-[2.4em] text-center font-mono tracking-[0.2em]"
      />
      <Button type="submit" variant="secondary" disabled={!complete} className="tv-body h-[2.2em]">
        Show code
      </Button>
    </form>
  );
}

function JoinQr({ url }: { url: string }) {
  const { size, path } = qrShape(url);
  const quiet = 2;
  return (
    <svg
      role="img"
      aria-label={`QR code for ${url}`}
      viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
      className="size-[14em] rounded-xl bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
