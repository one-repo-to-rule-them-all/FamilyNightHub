"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  AGE_CAPS,
  MAX_STREAMING_PROVIDERS,
  NO_AGE_CAP,
  ageCapFromSelect,
  normalizeRegion,
  sameIds,
  toggleProvider,
} from "@/lib/admin";
import {
  type ApiError,
  type HouseholdSettings,
  type Schemas,
  type VotingMethod,
  api,
} from "@/lib/api";
import { joinUrl } from "@/lib/join-link";
import { VOTING_METHODS } from "@/lib/voting-method";

import { AdminQueryError } from "../admin-error";

const SETTINGS_KEY = ["admin", "settings"] as const;
const PROVIDERS_KEY = ["tmdb", "providers"] as const;
const TMDB_LOGO_BASE = "https://image.tmdb.org/t/p/w92";
const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

export function SettingsAdmin() {
  const settings = useQuery<HouseholdSettings, ApiError>({
    queryKey: SETTINGS_KEY,
    queryFn: api.settings,
  });

  if (settings.isError) return <AdminQueryError error={settings.error} />;
  if (settings.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading settings…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <JoinLink slug={settings.data.join_slug} />
      <Defaults settings={settings.data} />
      <StreamingServices saved={settings.data.streaming_providers} region={settings.data.region} />
    </div>
  );
}

function Section({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {lede ? <p className="text-sm text-muted-foreground">{lede}</p> : null}
      </div>
      <div className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        {children}
      </div>
    </section>
  );
}

function JoinLink({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [rotated, setRotated] = useState(false);
  const rotate = useMutation<Schemas["JoinSlugOut"], ApiError>({
    mutationFn: api.rotateJoinSlug,
    onSuccess: ({ join_slug }) => {
      queryClient.setQueryData<HouseholdSettings>(SETTINGS_KEY, (old) =>
        old ? { ...old, join_slug } : old,
      );
      setConfirming(false);
      setRotated(true);
    },
  });
  // Client-only: this renders once the settings query has data, never on the server.
  const url = joinUrl(window.location.origin, slug);

  return (
    <Section
      title="Join link"
      lede="The fridge QR opens this page; phones then type the night code from the TV."
    >
      <p className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">
          {rotated ? "New join link (reprint the fridge QR):" : "Current join link:"}
        </span>
        <code className="font-mono text-base break-all" data-testid="join-url">
          {url}
        </code>
      </p>
      {rotated ? (
        <p role="status" className="text-sm" data-testid="slug-rotated">
          The old link and the printed QR no longer work.
        </p>
      ) : null}
      <Button
        variant="outline"
        size="lg"
        className="self-start px-4"
        onClick={() => {
          rotate.reset();
          setConfirming(true);
        }}
      >
        Rotate join link…
      </Button>
      {confirming ? (
        <ModalDialog
          title="Rotate the join link?"
          onClose={() => setConfirming(false)}
          testId="rotate-confirm"
        >
          <div className="flex flex-col gap-2 text-sm">
            <p>
              <strong>The printed fridge QR stops working right away</strong>, and so does any copy
              of the current link. You&apos;ll get a new link to print as a new QR.
            </p>
            <p className="text-muted-foreground">
              Phones that have already joined keep working. Do this if the link got out beyond the
              family.
            </p>
          </div>
          <ApiErrorNotice error={rotate.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="lg"
              className="px-4"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? "Rotating…" : "Rotate link"}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </Section>
  );
}

const SELECT_CLASS =
  "h-11 rounded-lg border border-input bg-input/30 px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Defaults({ settings }: { settings: HouseholdSettings }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<VotingMethod>(settings.default_voting_method);
  const [ageCap, setAgeCap] = useState<string>(settings.default_age_cap ?? NO_AGE_CAP);
  const [region, setRegion] = useState(settings.region);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation<HouseholdSettings, ApiError, Schemas["SettingsUpdateIn"]>({
    mutationFn: api.updateSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      // The streaming list is per region.
      if (next.region !== settings.region) {
        void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      }
      setSaved(true);
    },
  });

  return (
    <Section title="Defaults" lede="Used for every new night unless the host changes it.">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const code = normalizeRegion(region);
          setRegionError(code ? null : "Use a two-letter country code, like US or GB.");
          setSaved(false);
          if (!code || save.isPending) return;
          save.mutate({
            default_voting_method: method,
            default_age_cap: ageCapFromSelect(ageCap),
            region: code,
          });
        }}
      >
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-method`}>How we vote</Label>
            <select
              id={`${id}-method`}
              value={method}
              aria-describedby={`${id}-method-help`}
              onChange={(event) => setMethod(event.target.value as VotingMethod)}
              className={SELECT_CLASS}
            >
              {VOTING_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p id={`${id}-method-help`} className="max-w-xs text-sm text-muted-foreground">
              {VOTING_METHODS.find((m) => m.value === method)?.explanation}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-age`}>Age cap</Label>
            <select
              id={`${id}-age`}
              value={ageCap}
              onChange={(event) => setAgeCap(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value={NO_AGE_CAP}>No cap</option>
              {AGE_CAPS.map((cap) => (
                <option key={cap} value={cap}>
                  Up to {cap}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-region`}>Region</Label>
            <Input
              id={`${id}-region`}
              value={region}
              maxLength={2}
              autoComplete="off"
              aria-invalid={regionError ? true : undefined}
              aria-describedby={`${id}-region-help`}
              onChange={(event) => setRegion(event.target.value)}
              className="h-11 w-24 uppercase"
            />
            <p id={`${id}-region-help`} className="text-sm text-muted-foreground">
              {regionError ?? "Country code for ratings and streaming, e.g. US."}
            </p>
          </div>
        </div>
        <ApiErrorNotice error={save.error} />
        {saved ? (
          <p role="status" className="text-sm" data-testid="defaults-saved">
            Saved.
          </p>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          className="self-start px-4"
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save defaults"}
        </Button>
      </form>
    </Section>
  );
}

function StreamingServices({ saved, region }: { saved: number[]; region: string }) {
  const queryClient = useQueryClient();
  const providers = useQuery<Schemas["ProvidersOut"], ApiError>({
    queryKey: PROVIDERS_KEY,
    queryFn: api.streamingProviders,
  });
  const [selected, setSelected] = useState<number[]>(saved);
  const [done, setDone] = useState(false);
  const save = useMutation<HouseholdSettings, ApiError, number[]>({
    mutationFn: (ids) => api.updateSettings({ streaming_providers: ids }),
    onSuccess: (next) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      setDone(true);
    },
  });
  const full = selected.length >= MAX_STREAMING_PROVIDERS;
  const unavailable = providers.error?.status === 503;

  return (
    <Section
      title="Streaming services"
      lede={`The ones the family pays for in ${region}, so suggestions can favour what you can watch tonight. Up to ${MAX_STREAMING_PROVIDERS}.`}
    >
      {providers.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading services…
        </p>
      ) : null}
      {unavailable ? (
        <p role="alert" data-testid="providers-unavailable">
          The streaming list can&apos;t be loaded right now. Your {saved.length} saved{" "}
          {saved.length === 1 ? "service stays" : "services stay"} as they are; try again later.
        </p>
      ) : providers.isError ? (
        <ApiErrorNotice error={providers.error} />
      ) : null}

      {providers.data ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!save.isPending) save.mutate(selected);
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm" data-testid="providers-count">
              {selected.length} of {MAX_STREAMING_PROVIDERS} picked
            </legend>
            {providers.data.providers.length === 0 ? (
              <p className="text-muted-foreground">No services listed for {region}.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {providers.data.providers.map((p) => {
                  const checked = selected.includes(p.provider_id);
                  return (
                    <li key={p.provider_id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted has-checked:bg-secondary has-disabled:cursor-not-allowed has-disabled:opacity-50">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && full}
                          onChange={() => {
                            setDone(false);
                            setSelected((s) => toggleProvider(s, p.provider_id));
                          }}
                          className="size-5 shrink-0 accent-[var(--accent-cinema)]"
                        />
                        {p.logo_path ? (
                          // eslint-disable-next-line @next/next/no-img-element -- TMDB CDN, sized by the URL itself
                          <img
                            src={`${TMDB_LOGO_BASE}${p.logo_path}`}
                            alt=""
                            width={28}
                            height={28}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            // A missing logo just goes away; the name carries the meaning.
                            onError={(event) => {
                              event.currentTarget.style.visibility = "hidden";
                            }}
                            className="size-7 shrink-0 rounded-md"
                          />
                        ) : null}
                        <span className="text-sm">{p.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          {full ? (
            <p className="text-sm text-muted-foreground">
              That&apos;s the limit. Untick one to pick another.
            </p>
          ) : null}
          <ApiErrorNotice error={save.error} />
          {done ? (
            <p role="status" className="text-sm" data-testid="providers-saved">
              Saved {selected.length} {selected.length === 1 ? "service" : "services"}.
            </p>
          ) : null}
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            className="self-start px-4"
            disabled={save.isPending || sameIds(selected, saved)}
          >
            {save.isPending ? "Saving…" : "Save services"}
          </Button>
          <p className="text-xs text-muted-foreground" data-testid="justwatch-attribution">
            {providers.data.attribution}
          </p>
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground" data-testid="tmdb-attribution">
        Streaming services from TMDB. {TMDB_NOTICE}
      </p>
    </Section>
  );
}
