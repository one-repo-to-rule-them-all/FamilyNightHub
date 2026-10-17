/**
 * The TV's help nudge (guest-flow spec §5 TV, `copy.tv.help`): a corner line while a phone's
 * person claim waits for the host. Fed by `GET /devices/me/help-count`, which counts pending
 * claims only, so a PIN reset (admin only) can never reach the TV.
 */
import type { Schemas } from "@/lib/api";

/** The TV re-reads the count this often (AC-11.4: within 10 s). */
export const TV_HELP_POLL_MS = 10_000;

/** Who to name in `copy.tv.help`, or `null` when nobody is waiting. */
export function tvHelpName(help: Schemas["HelpCountOut"] | null | undefined): string | null {
  if (!help || help.count <= 0) return null;
  return help.first_name?.trim() || "Someone";
}
