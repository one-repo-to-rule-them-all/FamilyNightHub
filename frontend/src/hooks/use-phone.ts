"use client";

import { useQuery } from "@tanstack/react-query";

import {
  api,
  type ApiError,
  type NightStatus,
  type NightSummary,
  type PersonTile,
} from "@/lib/api";
import { isDeviceExpired } from "@/lib/device-idle";
import {
  currentPerson,
  LIVE_NIGHT_POLL_MS,
  LIVE_NIGHT_STATUSES,
  waitingPollInterval,
} from "@/lib/who";

export const PEOPLE_KEY = ["people"] as const;
export const LIVE_NIGHT_KEY = ["nights", "live"] as const;
export const LATEST_NIGHT_KEY = ["nights", "latest"] as const;

/** Every status, so the newest night of any kind decides That's a wrap vs the recap (guest-home §6). */
const ALL_NIGHT_STATUSES: NightStatus[] = [...LIVE_NIGHT_STATUSES, "closed"];
/** How often a closed night's screen re-checks which night is the household's latest. */
export const LATEST_NIGHT_POLL_MS = 30_000;

/**
 * The phone's two resolver facts (guest-flow spec §3): who it is acting as, from `GET /people`
 * (a 401 means this browser has no device; `expired` when it went unused for 30 days, issue #56),
 * and the household's live night, polled every 5 s and on focus so a waiting screen moves on by
 * itself.
 */
export function usePhonePeople() {
  const people = useQuery<PersonTile[], ApiError>({
    queryKey: PEOPLE_KEY,
    queryFn: api.people,
    refetchInterval: (query) => waitingPollInterval(query.state.data),
    refetchOnWindowFocus: true,
  });
  return {
    people,
    current: currentPerson(people.data),
    noDevice: people.error?.status === 401,
    expired: isDeviceExpired(people.error),
  };
}

/**
 * The household's live night (`["nights","live"]`). One query, shared by the resolver and the
 * guest shell (`useHouseholdNight`): 5 s while the page is visible (never in the background, so a
 * pocketed phone costs nothing), and again on focus.
 */
export function useLiveNight(enabled: boolean) {
  const live = useQuery<NightSummary[], ApiError>({
    queryKey: LIVE_NIGHT_KEY,
    queryFn: () => api.nights({ status: LIVE_NIGHT_STATUSES, limit: 1 }),
    enabled,
    refetchInterval: LIVE_NIGHT_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  return live;
}

/**
 * The household's newest night of any status (`["nights","latest"]`, guest-home §6): a closed
 * night is That's a wrap when it is this one, else the recap (`pastNightKind`). Mount it only on a
 * closed night's screen; 30 s and on focus.
 */
export function useLatestNight(enabled: boolean) {
  return useQuery<NightSummary[], ApiError>({
    queryKey: LATEST_NIGHT_KEY,
    queryFn: () => api.nights({ status: ALL_NIGHT_STATUSES, limit: 1 }),
    enabled,
    refetchInterval: LATEST_NIGHT_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
