"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { UseAsTvSection } from "@/components/portal/use-as-tv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  AGE_CAPS,
  describeStartFresh,
  MAX_STREAMING_PROVIDERS,
  NO_AGE_CAP,
  startFreshArmed,
  toggleProvider,
} from "@/lib/admin";
import {
  type Account,
  type ApiError,
  type HouseholdSettings,
  type Schemas,
  type VotingMethod,
  api,
  type StartFreshResult,
} from "@/lib/api";
import { joinUrl } from "@/lib/join-link";
import { PASSWORD_MIN } from "@/lib/password";
import { cn } from "@/lib/utils";
import { VOTING_METHODS } from "@/lib/voting-method";

import { AdminQueryError } from "../admin-error";
import {
  type DirtyOrder,
  type Group,
  type GroupId,
  type PasswordDraft,
  type SaveLook,
  ageCapSelectValue,
  markDirty,
  nightsPatch,
  passwordDirty,
  passwordPatch,
  saveLook,
  streamingDirty,
  streamingPatch,
  visibleGroups,
} from "./groups";
import { HostsAdmins } from "./hosts-admins";

const ME_KEY = ["me"] as const;
const SETTINGS_KEY = ["admin", "settings"] as const;
const PROVIDERS_KEY = ["tmdb", "providers"] as const;
const TMDB_LOGO_BASE = "https://image.tmdb.org/t/p/w92";
const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

type DirtyFn = (group: GroupId, dirty: boolean) => void;

/**
 * Settings (proposals/owner-portal.md §5 P5): named groups, each with its own Save, so a save
 * never mixes groups. Only the group with the newest unsaved change has the filled Save (the
 * screen's one primary). A host sees Your account and This browser only, and the admin settings
 * query is never sent for them.
 */
export function SettingsAdmin() {
  const me = useQuery<Account, ApiError>({ queryKey: ME_KEY, queryFn: api.me });
  const isAdmin = me.data?.role === "admin";
  const settings = useQuery<HouseholdSettings, ApiError>({
    queryKey: SETTINGS_KEY,
    queryFn: api.settings,
    enabled: isAdmin,
  });
  const [order, setOrder] = useState<DirtyOrder>([]);
  const onDirty = useCallback<DirtyFn>(
    (group, dirty) => setOrder((o) => markDirty(o, group, dirty)),
    [],
  );

  if (me.isError) return <ApiErrorNotice error={me.error} />;
  if (isAdmin && settings.isError) return <AdminQueryError error={settings.error} />;
  if (me.isPending || (isAdmin && settings.isPending)) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading settings…
      </p>
    );
  }

  const groups = visibleGroups(me.data.role);
  const look = (g: GroupId) => saveLook(order, g);
  const sections: Record<GroupId, React.ReactNode> = {
    joining: settings.data ? <Joining settings={settings.data} /> : null,
    nights: settings.data ? (
      <MovieNights settings={settings.data} look={look("nights")} onDirty={onDirty} />
    ) : null,
    streaming: settings.data ? (
      <Streaming settings={settings.data} look={look("streaming")} onDirty={onDirty} />
    ) : null,
    accounts: isAdmin ? <HostsAdmins /> : null,
    account: <YourAccount account={me.data} look={look("account")} onDirty={onDirty} />,
    browser: <ThisBrowser />,
    fresh: isAdmin ? <StartFresh familyName={me.data.household_name} /> : null,
  };

  return (
    <div data-screen="portal-settings" className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">Settings</h2>
      <div className={cn("grid gap-6", groups.length > 2 && "md:grid-cols-[11rem_minmax(0,1fr)]")}>
        {groups.length > 2 ? <SubNav groups={groups} /> : null}
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map((g) => (
            <GroupSection key={g.id} group={g}>
              {sections[g.id]}
            </GroupSection>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Desktop: a sticky list beside the groups. Phone: a row of chips above them. */
function SubNav({ groups }: { groups: Group[] }) {
  const [active, setActive] = useState<GroupId>(groups[0].id);
  return (
    <nav
      aria-label="Settings sections"
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 md:sticky md:top-4 md:mx-0 md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:p-0"
    >
      {groups.map((g) => (
        <a
          key={g.id}
          href={`#${g.id}`}
          aria-current={active === g.id ? "location" : undefined}
          onClick={() => setActive(g.id)}
          className="flex h-9 shrink-0 items-center rounded-full px-3 text-sm whitespace-nowrap text-muted-foreground ring-1 ring-foreground/10 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current]:bg-muted aria-[current]:text-foreground md:rounded-lg md:ring-0"
        >
          {g.label}
        </a>
      ))}
    </nav>
  );
}

function GroupSection({ group, children }: { group: Group; children: React.ReactNode }) {
  const titleId = `${group.id}-title`;
  return (
    <section
      id={group.id}
      aria-labelledby={titleId}
      className="flex scroll-mt-4 flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
    >
      <h3 id={titleId} className="text-lg font-semibold">
        {group.label}
      </h3>
      {children}
    </section>
  );
}

/** A group's footer: its status and its Save, filled only when it is the screen's primary. */
function SaveFooter({
  look,
  saved,
  pending,
  label = "Save",
}: {
  look: SaveLook;
  saved: boolean;
  pending: boolean;
  label?: string;
}) {
  const primary = look === "primary";
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-foreground/10 pt-3">
      <p role="status" className="text-sm text-muted-foreground" data-testid="save-status">
        {look !== "idle" ? "Unsaved changes" : saved ? "Saved" : ""}
      </p>
      <Button
        type="submit"
        variant={primary ? "default" : "secondary"}
        size="lg"
        className="px-4"
        disabled={look === "idle" || pending}
        data-testid={primary ? "primary-action" : undefined}
      >
        {pending ? "Saving…" : label}
      </Button>
    </div>
  );
}

/** Reports a group's dirty state up, and clears it when the group unmounts. */
function useReportDirty(group: GroupId, dirty: boolean, onDirty: DirtyFn) {
  useEffect(() => {
    onDirty(group, dirty);
  }, [group, dirty, onDirty]);
  useEffect(() => () => onDirty(group, false), [group, onDirty]);
}

// ── Joining ─────────────────────────────────────────────────────────────────────────────────────

/** Join link + rotate, and #40's QR toggle (saves on change, as before; nothing to Save here). */
function Joining({ settings }: { settings: HouseholdSettings }) {
  return (
    <>
      <JoinLink slug={settings.join_slug} />
      <QrCodeSetting settings={settings} />
    </>
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
    <div className="flex flex-col gap-3">
      <p className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">
          {rotated
            ? "New join link (reprint the fridge QR):"
            : "Join link (the fridge QR opens it; phones then type the night code from the TV):"}
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
        variant="secondary"
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
    </div>
  );
}

/**
 * "Include tonight's code in the TV QR" (owner decision §10.1, gap G9), off by default. On: the
 * TV's QR is `/j/{slug}?code=…` and guests just tap Join. Off: they scan, then type the code.
 * The TV picks the change up on its next refetch (≤ 10 s).
 */
function QrCodeSetting({ settings }: { settings: HouseholdSettings }) {
  const id = useId();
  const queryClient = useQueryClient();
  // Set in the same event as the click: the mutation's pending state lands a tick later, and until
  // then the controlled checkbox snapped back to the old value (a flicker; flaky in e2e, #42).
  const [wanted, setWanted] = useState<boolean | null>(null);
  const save = useMutation<HouseholdSettings, ApiError, boolean>({
    mutationFn: (on) => api.updateSettings({ qr_includes_night_code: on }),
    onSuccess: (next) => queryClient.setQueryData(SETTINGS_KEY, next),
    onSettled: () => setWanted(null),
  });
  const on = wanted ?? settings.qr_includes_night_code;

  return (
    <div className="flex flex-col gap-2 border-t border-foreground/10 pt-4">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={on}
          disabled={save.isPending}
          aria-describedby={`${id}-help`}
          onChange={(event) => {
            setWanted(event.target.checked);
            save.mutate(event.target.checked);
          }}
          className="mt-1 size-5 shrink-0 accent-[var(--accent-cinema)]"
          data-testid="qr-code-setting"
        />
        <span className="flex flex-col gap-1">
          <span className="font-medium">Include tonight&apos;s code in the TV QR</span>
          <span id={`${id}-help`} className="text-sm text-muted-foreground">
            Guests who scan the TV just tap Join. Anyone who sees the TV, or a photo of it, can join
            until the night ends. Off: they scan, then type the code.
          </span>
        </span>
      </label>
      <ApiErrorNotice error={save.error} />
    </div>
  );
}

// ── Movie nights ────────────────────────────────────────────────────────────────────────────────

const SELECT_CLASS =
  "h-11 rounded-lg border border-input bg-input/30 px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function MovieNights({
  settings,
  look,
  onDirty,
}: {
  settings: HouseholdSettings;
  look: SaveLook;
  onDirty: DirtyFn;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<VotingMethod>(settings.default_voting_method);
  const [ageCap, setAgeCap] = useState(ageCapSelectValue(settings.default_age_cap));
  const body = nightsPatch(settings, { method, ageCap });
  const dirty = Object.keys(body).length > 0;
  useReportDirty("nights", dirty, onDirty);
  const save = useMutation<HouseholdSettings, ApiError, Schemas["SettingsUpdateIn"]>({
    mutationFn: api.updateSettings,
    onSuccess: (next) => queryClient.setQueryData(SETTINGS_KEY, next),
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate(body);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Used for every new night unless the host changes it.
      </p>
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
      </div>
      <ApiErrorNotice error={save.error} />
      <SaveFooter look={look} saved={save.isSuccess} pending={save.isPending} />
    </form>
  );
}

// ── Streaming ───────────────────────────────────────────────────────────────────────────────────

function Streaming({
  settings,
  look,
  onDirty,
}: {
  settings: HouseholdSettings;
  look: SaveLook;
  onDirty: DirtyFn;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const providers = useQuery<Schemas["ProvidersOut"], ApiError>({
    queryKey: PROVIDERS_KEY,
    queryFn: api.streamingProviders,
  });
  const [region, setRegion] = useState(settings.region);
  const [selected, setSelected] = useState<number[]>(settings.streaming_providers);
  const [regionError, setRegionError] = useState<string | null>(null);
  const draft = { region, providers: selected };
  useReportDirty("streaming", streamingDirty(settings, draft), onDirty);
  const save = useMutation<HouseholdSettings, ApiError, Schemas["SettingsUpdateIn"]>({
    mutationFn: api.updateSettings,
    onSuccess: (next) => {
      // The streaming list is per region.
      if (next.region !== settings.region) {
        void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      }
      queryClient.setQueryData(SETTINGS_KEY, next);
      setRegion(next.region);
    },
  });
  const full = selected.length >= MAX_STREAMING_PROVIDERS;
  const unavailable = providers.error?.status === 503;
  const saved = settings.streaming_providers;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const patch = streamingPatch(settings, draft);
        setRegionError("error" in patch ? patch.error : null);
        if ("body" in patch && !save.isPending) save.mutate(patch.body);
      }}
    >
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

      <p className="text-sm text-muted-foreground">
        The services the family pays for in {settings.region}, so suggestions can favour what you
        can watch tonight. Up to {MAX_STREAMING_PROVIDERS}.
      </p>
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
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm" data-testid="providers-count">
              {selected.length} of {MAX_STREAMING_PROVIDERS} picked
            </legend>
            {providers.data.providers.length === 0 ? (
              <p className="text-muted-foreground">No services listed for {settings.region}.</p>
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
                          onChange={() => setSelected((s) => toggleProvider(s, p.provider_id))}
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
          <p className="text-xs text-muted-foreground" data-testid="justwatch-attribution">
            {providers.data.attribution}
          </p>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground" data-testid="tmdb-attribution">
        Streaming services from TMDB. {TMDB_NOTICE}
      </p>
      <ApiErrorNotice error={save.error} />
      <SaveFooter look={look} saved={save.isSuccess} pending={save.isPending} />
    </form>
  );
}

// ── Your account ────────────────────────────────────────────────────────────────────────────────

const NO_PASSWORD: PasswordDraft = { current: "", next: "", confirm: "" };

/** Who's signed in, and ADR-0014's set/change password (`POST /auth/password`). */
function YourAccount({
  account,
  look,
  onDirty,
}: {
  account: Account;
  look: SaveLook;
  onDirty: DirtyFn;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PasswordDraft>(NO_PASSWORD);
  const [problem, setProblem] = useState<string | null>(null);
  useReportDirty("account", passwordDirty(draft), onDirty);
  const save = useMutation<void, ApiError, Schemas["PasswordIn"]>({
    mutationFn: api.setPassword,
    onSuccess: () => {
      setDraft(NO_PASSWORD);
      // `has_password` flips after a first password.
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
  const edit = (field: keyof PasswordDraft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setProblem(null);
    setDraft((d) => ({ ...d, [field]: event.target.value }));
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const patch = passwordPatch(account.has_password, draft);
        setProblem("error" in patch ? patch.error : null);
        if ("body" in patch && !save.isPending) save.mutate(patch.body);
      }}
    >
      <dl
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm"
        data-testid="account-details"
      >
        <dt className="text-muted-foreground">Name</dt>
        <dd>{account.display_name}</dd>
        <dt className="text-muted-foreground">Username</dt>
        <dd>{account.username ?? "—"}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="break-all">{account.email}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>{account.role === "admin" ? "Family admin" : "Host"}</dd>
      </dl>

      <fieldset className="flex flex-col gap-3 border-t border-foreground/10 pt-4">
        <legend className="font-medium">
          {account.has_password ? "Change password" : "Set a password"}
        </legend>
        {account.has_password ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-current`}>Current password</Label>
            <Input
              id={`${id}-current`}
              type="password"
              autoComplete="current-password"
              value={draft.current}
              onChange={edit("current")}
              className="h-11 max-w-sm"
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-new`}>New password</Label>
          <Input
            id={`${id}-new`}
            type="password"
            autoComplete="new-password"
            placeholder={`${PASSWORD_MIN} characters or more`}
            value={draft.next}
            onChange={edit("next")}
            className="h-11 max-w-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-confirm`}>Type it again</Label>
          <Input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={draft.confirm}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-problem`}
            onChange={edit("confirm")}
            className="h-11 max-w-sm"
          />
        </div>
        <p id={`${id}-problem`} role={problem ? "alert" : undefined} className="text-sm">
          {problem}
        </p>
      </fieldset>
      <ApiErrorNotice error={save.error} />
      <SaveFooter
        look={look}
        saved={save.isSuccess}
        pending={save.isPending}
        label={account.has_password ? "Change password" : "Set password"}
      />
    </form>
  );
}

// ── This browser ────────────────────────────────────────────────────────────────────────────────

function ThisBrowser() {
  const router = useRouter();
  const logout = useMutation<void, ApiError>({
    mutationFn: api.logout,
    onSuccess: () => router.replace("/login"),
  });
  return (
    <>
      <UseAsTvSection />
      <div className="flex flex-col gap-2 border-t border-foreground/10 pt-4">
        <ApiErrorNotice error={logout.error} />
        <Button
          variant="ghost"
          size="lg"
          className="self-start px-4"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
          data-testid="settings-sign-out"
        >
          {logout.isPending ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </>
  );
}

/** #94: clear every person, phone and night. The admin types the family name to arm it. */
function StartFresh({ familyName }: { familyName: string }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const fresh = useMutation<StartFreshResult, ApiError>({
    mutationFn: () => api.startFresh(typed),
    onSuccess: (result) => {
      setTyped("");
      setDone(describeStartFresh(result));
      void queryClient.invalidateQueries();
    },
  });
  const armed = startFreshArmed(typed, familyName);
  return (
    <div className="flex flex-col gap-3" data-testid="start-fresh">
      <p className="text-sm text-muted-foreground">
        Clears every person, phone, TV and night, with their votes, ratings and photos. Your family,
        accounts, settings and movie library stay. Every phone joins again with tonight&apos;s code.
        This can&apos;t be undone.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>
          Type <strong>{familyName}</strong> to confirm
        </Label>
        <Input
          id={`${id}-name`}
          value={typed}
          autoComplete="off"
          onChange={(e) => {
            setTyped(e.target.value);
            setDone(null);
          }}
        />
      </div>
      <ApiErrorNotice error={fresh.error} />
      <div>
        <Button
          variant="destructive"
          size="lg"
          className="px-4"
          disabled={!armed || fresh.isPending}
          onClick={() => fresh.mutate()}
        >
          {fresh.isPending ? "Clearing…" : "Start fresh"}
        </Button>
      </div>
      <p aria-live="polite" className="text-sm empty:hidden" data-testid="start-fresh-done">
        {done}
      </p>
    </div>
  );
}
