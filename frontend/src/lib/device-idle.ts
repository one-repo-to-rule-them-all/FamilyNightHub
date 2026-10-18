/**
 * Device idle timeout (issue #56, ADR-0002 amendment). A phone or TV unused for 30 days gets
 * 401 `device_expired` on every device request. It is not revoked: a phone enters tonight's code
 * again at `/j/{slug}`, and a TV needs a host to choose "Use this browser as the TV" again.
 */
import { ApiError } from "./api";

export const DEVICE_EXPIRED = "device_expired";
export const DEVICE_IDLE_DAYS = 30;

export const DEVICE_EXPIRED_COPY = {
  phone: "It's been a while. Enter tonight's code.",
  /** The resolver's S0 when this browser has no remembered door to send it back to. */
  landing: "It's been a while. Scan the QR code on the fridge or the TV to join again.",
  tvTitle: "This TV needs pairing again",
  tv: `It hasn't been used in ${DEVICE_IDLE_DAYS} days.`,
  admin: `Expired (not used in ${DEVICE_IDLE_DAYS} days)`,
} as const;

export function isDeviceExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === DEVICE_EXPIRED;
}
