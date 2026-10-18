import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { DEVICE_EXPIRED_COPY, isDeviceExpired } from "./device-idle";

describe("device idle timeout", () => {
  it("tells an expired device apart from an unknown one", () => {
    expect(isDeviceExpired(new ApiError(401, "device_expired", "It's been a while."))).toBe(true);
    expect(isDeviceExpired(new ApiError(401, "http_error", "Device not recognised"))).toBe(false);
    expect(isDeviceExpired(new ApiError(403, "device_expired", "?"))).toBe(false);
    expect(isDeviceExpired(null)).toBe(false);
  });

  it("names the 30-day window on the Phones screen", () => {
    expect(DEVICE_EXPIRED_COPY.admin).toBe("Expired (not used in 30 days)");
  });
});
