import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "./proxy";

function visit(path: string, cookies: string[] = []) {
  const request = new NextRequest(new URL(path, "https://fnh.test"), {
    headers: { cookie: cookies.map((name) => `${name}=x`).join("; ") },
  });
  return proxy(request).headers.get("location");
}

describe("proxy", () => {
  it("sends a browser without a session from the portal to /login", () => {
    expect(visit("/admin/people")).toBe("https://fnh.test/login");
    expect(visit("/admin/people", ["fnh_session"])).toBeNull();
  });

  it("lets a platform operator inside a household into the portal (ADR-0016)", () => {
    expect(visit("/host", ["fnh_platform"])).toBeNull();
  });

  it("sends /platform without a platform session to its own sign-in", () => {
    expect(visit("/platform")).toBe("https://fnh.test/platform/login");
    // A family session is not a platform session.
    expect(visit("/platform", ["fnh_session"])).toBe("https://fnh.test/platform/login");
    expect(visit("/platform", ["fnh_platform"])).toBeNull();
    expect(visit("/platform/login")).toBeNull();
  });
});
