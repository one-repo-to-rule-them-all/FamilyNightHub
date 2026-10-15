import type { NextConfig } from "next";

// ADR-0001: fnh-web proxies /api/* to fnh-api over Fly's private network so the
// device and session cookies stay first-party. API_INTERNAL_URL is server-only.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
