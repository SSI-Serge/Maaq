import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Les paquets natifs restent côté serveur, hors du bundle.
  serverExternalPackages: ["@node-rs/argon2", "pg", "embedded-postgres"],
  poweredByHeader: false,
};

export default nextConfig;
