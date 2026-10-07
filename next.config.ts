import type { NextConfig } from "next";
import { loadExternalEnv } from "./src/lib/external-env";
import { getSecurityHeaders } from "./src/lib/security-headers";

// Secrets live outside the (OneDrive-synced) project: <home>/.skybook-qc/.env.local.
// Next.js has already read any project .env files; those values win.
loadExternalEnv();

const nextConfig: NextConfig = {
  // Don't announce the framework in every response.
  poweredByHeader: false,

  experimental: {
    // Turbopack's on-disk cache stores a snapshot of the whole process
    // environment — including the secrets loaded above — in .next/, inside
    // the synced project folder. Keep its cache in memory only.
    turbopackFileSystemCacheForBuild: false,
    turbopackFileSystemCacheForDev: false,
    serverActions: {
      // Room for a 2 MB logo (the largest allowed) plus the form around it.
      // Every other action sends far less. The logo action checks 2 MB itself.
      bodySizeLimit: "3mb",
    },
  },

  // Security headers on every path — pages, API routes and static files.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: getSecurityHeaders(process.env.NODE_ENV === "production"),
      },
    ];
  },
};

export default nextConfig;
