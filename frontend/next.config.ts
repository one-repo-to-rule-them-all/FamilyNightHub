import type { NextConfig } from "next";

// ADR-0001: fnh-web proxies /api/* to fnh-api over Fly's private network so the
// device and session cookies stay first-party. API_INTERNAL_URL is server-only.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    // A TV QR can carry tonight's code as `/j/{slug}?code=…` (ADR-0014 G9): never leak that URL
    // to another origin through Referer.
    return [{ source: "/j/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
