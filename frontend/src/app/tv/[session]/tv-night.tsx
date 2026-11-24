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
import { fitAvatars, TV_TURNOUT_STEPS, type TvTileSize } from "@/lib/avatar-fit";
import { api, ApiError, type JoinLink, type Night, type Person, type Schemas } from "@/lib/api";
import { DEVICE_EXPIRED_COPY, isDeviceExpired } from "@/lib/device-idle";
import { qrShape, tvJoinUrl } from "@/lib/join-link";
import {
  forgetNightCode,
  nightCodeIsLive,
  recallNightCode,
  rememberNightCode,
} from "@/lib/night-code-handoff";
import { cleanNightCodeInput, completeNightCode } from "@/lib/night-code";
import { runKey, tvPlays } from "@/lib/slideshow-control";
import { TV_HELP_POLL_MS, tvHelpName } from "@/lib/tv-help";
import { cn } from "@/lib/utils";

import { useCurrentNight } from "../tv-home";
import { Reveal } from "./reveal";
import { DropPrompt, TvSlideshow } from "./slideshow";

/** The TV re-reads the join link and the code-in-QR setting this often (spec §5 TV: ≤ 10 s). */
const JOIN_LINK_REFRESH_MS = 10_000;

/** /tv/[session]: lobby → turnout → reveal → photo slideshow, pushed live (polling only while the stream is down). */
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
    // Unused for 30 days (issue #56): a host pairs it again, same as a new TV.
    const expired = isDeviceExpired(night.error);
    return (
      <p
        className="tv-title m-auto text-center"
        data-testid="tv-unpaired"
        data-expired={expired || undefined}
      >
        {expired
          ? `${DEVICE_EXPIRED_COPY.tv} A host can pair it again from the host page.`
          : "This screen isn't paired. A host can pair it from the host page."}
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
    <div
      className="flex min-h-0 flex-1 flex-col gap-[1.5em]"
      data-live={live}
      data-status={data.status}
    >
      <header className="tv-clear-corner flex min-w-0 items-baseline justify-between gap-[1em]">
        <h1 className="tv-title min-w-[20%] truncate">{data.title || "Movie night"}</h1>
        <div className="flex shrink-0 items-baseline gap-[1em]">
          {data.status === "draft" || data.status === "voting" ? <HelpNudge /> : null}
          {live === "reconnecting" ? (
            <p
              className="tv-body shrink-0 text-muted-foreground"
              role="status"
              data-testid="tv-live-status"
            >
              Reconnecting…
            </p>
          ) : null}
        </div>
      </header>

      {data.status === "draft" || data.status === "voting" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] grid-rows-[minmax(0,1fr)] gap-[2.5em]">
          <JoinPanel sessionId={data.id} />
          <div className="flex min-h-0 flex-col gap-[1.5em]">
            <Headline night={data} voted={votedIds.size} total={people.data?.length ?? 0} />
            <Turnout
              people={people.data ?? []}
              voted={votedIds}
              voting={data.status === "voting"}
            />
          </div>
        </div>
      ) : null}

      {data.status === "tonight" || data.status === "closed" ? (
        tvPlays(data.slideshow) ? (
          // Each Start from the host is a new key: the slideshow restarts from the newest photo.
          <TvSlideshow key={runKey(data)} night={data} live={live} />
        ) : (
          // The host pressed Stop: hold on the drop prompt (no album fetch, no URLs) until Start.
          <DropPrompt night={data} count={0} held />
        )
      ) : data.result ? (
        <Reveal night={data} animate={data.status === "revealed"} />
      ) : null}
    </div>
  );
}

function Headline({ night, voted, total }: { night: Night; voted: number; total: number }) {
  if (night.status === "draft") {
    const n = night.options.length;
    return (
      <div className="flex flex-col gap-[0.5em]">
        <p className="tv-display tv-headline">Get comfy</p>
        <p className="tv-body text-muted-foreground" data-testid="tv-headline">
          The host is picking the shortlist{n > 0 ? ` (${n} so far)` : ""}. Join now so you&apos;re
          ready to vote.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[0.5em]">
      <p className="tv-display tv-headline">Vote on your phone</p>
      <p className="tv-body text-muted-foreground" data-testid="tv-headline" aria-live="polite">
        {voted} of {total} voted
      </p>
    </div>
  );
}

/**
 * The lobby's header line while a phone's person claim waits for the host (spec §5 TV, G4). In
 * the header, not floating, so it never covers the turnout tiles (issue #90).
 * Pending claims only: PIN resets are admin-only and never reach the TV. A 403 (this device
 * isn't the household's TV) stops the polling and shows nothing.
 */
function HelpNudge() {
  const help = useQuery<Schemas["HelpCountOut"], ApiError>({
    queryKey: ["devices", "me", "help-count"],
    queryFn: api.helpCount,
    refetchInterval: (query) => (query.state.error?.status === 403 ? false : TV_HELP_POLL_MS),
    retry: false,
  });
  const name = tvHelpName(help.data);
  return (
    <p
      role="status"
      className="tv-small max-w-[20em] truncate rounded-full bg-card px-[0.9em] py-[0.3em] ring-1 ring-foreground/10 empty:hidden"
      data-testid="tv-help"
    >
      {name ? (
        <>
          <strong>{name}</strong> is waiting for the host. Check your phone.
        </>
      ) : null}
    </p>
  );
}

/**
 * Each tile size with its column count (lib/avatar-fit.ts picks one from the head count), sized
 * to fit the lobby's right column at 16:9 without scrolling: about 37em × 21em (issue #90). The
 * avatar's box is 1.6 of its own font size, so `avatar` sets the whole avatar.
 */
const TILE: Record<
  TvTileSize,
  { grid: string; tile: string; avatar: string; name: string; check: string }
> = {
  xl: {
    grid: "grid-cols-3 gap-[1em]",
    tile: "gap-[0.3em] p-[0.8em]",
    avatar: "text-[3.1em]",
    name: "text-[1.5em]",
    check: "size-[1.4em]",
  },
  lg: {
    grid: "grid-cols-4 gap-[0.8em]",
    tile: "gap-[0.3em] p-[0.5em]",
    avatar: "text-[2.1em]",
    name: "text-[1.15em]",
    check: "size-[1.2em]",
  },
  md: {
    grid: "grid-cols-5 gap-[0.6em]",
    tile: "gap-[0.2em] p-[0.4em]",
    avatar: "text-[1.6em]",
    name: "text-[0.95em]",
    check: "size-[1em]",
  },
  sm: {
    grid: "grid-cols-6 gap-[0.5em]",
    tile: "gap-[0.15em] p-[0.3em]",
    avatar: "text-[1.25em]",
    name: "text-[0.8em]",
    check: "size-[0.9em]",
  },
};

/**
 * Turnout tiles: one per person, lit once their ballot is in. Never what they picked. As the
 * household grows the tiles shrink, and past 30 the rest fold into a "+N" tile.
 */
function Turnout({
  people,
  voted,
  voting,
}: {
  people: Person[];
  voted: Set<string>;
  voting: boolean;
}) {
  const fit = fitAvatars(people.length, TV_TURNOUT_STEPS);
  const t = TILE[fit.size];
  return (
    <ul
      className={cn("grid min-h-0 content-start", t.grid)}
      aria-label="Turnout"
      data-size={fit.size}
    >
      {people.slice(0, fit.shown).map((person) => {
        const done = voting && voted.has(person.id);
        return (
          <li
            key={person.id}
            data-testid="tv-tile"
            data-person={person.name}
            data-voted={done}
            aria-label={done ? `${person.name} has voted` : person.name}
            className={cn(
              "tv-tile relative flex min-w-0 flex-col items-center rounded-2xl bg-card ring-1 ring-foreground/10",
              t.tile,
              voting && !done && "opacity-45",
              done && "marquee-glow",
            )}
          >
            <Avatar
              emoji={person.avatar_emoji}
              color={person.color}
              className={cn("size-[1.6em] shrink-0", t.avatar)}
            />
            <span aria-hidden className={cn("w-full truncate text-center leading-tight", t.name)}>
              {person.name}
            </span>
            {done ? (
              <Check
                aria-hidden
                className={cn("absolute top-[0.3em] right-[0.3em] text-cinema", t.check)}
              />
            ) : null}
          </li>
        );
      })}
      {fit.more > 0 ? (
        <li
          data-testid="tv-tile-more"
          aria-label={`and ${fit.more} more`}
          className={cn(
            "flex min-w-0 flex-col items-center justify-center rounded-2xl bg-card text-muted-foreground ring-1 ring-foreground/10",
            t.tile,
          )}
        >
          <span aria-hidden className="text-[1.5em] font-semibold tabular-nums">
            +{fit.more}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The lobby's QR (guest-flow spec §5 TV, owner decision §10.1): `/j/{slug}` by default, with
 * tonight's code in it only when the admin turned that on and this TV holds the code (the server
 * never returns it, ADR-0002). If the join link can't be read, it points at the fridge QR.
 */
function JoinPanel({ sessionId }: { sessionId: string }) {
  const [code, setCode] = useState<string | null>(() => recallNightCode(sessionId));
  const link = useQuery<JoinLink | null, ApiError>({
    queryKey: ["devices", "me", "join-link"],
    queryFn: async () => {
      try {
        return await api.joinLink();
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403))
          return null;
        throw error;
      }
    },
    retry: false,
    refetchInterval: JOIN_LINK_REFRESH_MS,
  });
  const slug = link.data?.join_slug ?? null;
  const includeCode = link.data?.qr_includes_night_code ?? false;
  const url = slug ? tvJoinUrl(window.location.origin, slug, code, includeCode) : null;
  const codeInQr = url !== null && url.includes("?code=");

  return (
    <section
      aria-labelledby="tv-join"
      className="flex min-h-0 flex-col items-center justify-center gap-[1em] rounded-3xl bg-card p-[1.2em] text-center ring-1 ring-foreground/10"
    >
      <h2 id="tv-join" className="tv-body text-muted-foreground">
        {!url
          ? "Scan the fridge QR to join"
          : codeInQr
            ? "Scan to join"
            : "Scan, then type the code"}
      </h2>
      {url ? (
        // The QR takes the height left over, up to 14em: it gives way before anything scrolls.
        <div className="flex min-h-[6em] w-full flex-1 items-center justify-center">
          <JoinQr url={url} />
        </div>
      ) : null}
      {code ? (
        <>
          <p className="tv-body text-muted-foreground">{codeInQr ? "or type" : "then enter"}</p>
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
      className="flex w-full shrink-0 flex-col gap-[0.6em]"
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
      className="aspect-square h-full max-h-[14em] w-auto max-w-full rounded-xl bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
