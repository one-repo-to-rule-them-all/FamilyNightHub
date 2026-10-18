"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type NightSummary, type PersonTile } from "@/lib/api";
import { isDeviceExpired } from "@/lib/device-idle";
import {
  currentPerson,
  LIVE_NIGHT_POLL_MS,
  LIVE_NIGHT_STATUSES,
  waitingPollInterval,
} from "@/lib/who";

export const PEOPLE_KEY = ["people"] as const;
export const LIVE_NIGHT_KEY = ["nights", "live"] as const;

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

export function useLiveNight(enabled: boolean) {
  const live = useQuery<NightSummary[], ApiError>({
    queryKey: LIVE_NIGHT_KEY,
    queryFn: () => api.nights({ status: LIVE_NIGHT_STATUSES, limit: 1 }),
    enabled,
    refetchInterval: LIVE_NIGHT_POLL_MS,
    refetchOnWindowFocus: true,
  });
  return live;
}
