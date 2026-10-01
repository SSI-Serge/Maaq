import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Les paquets natifs restent côté serveur, hors du bundle.
  serverExternalPackages: ["@node-rs/argon2", "pg", "embedded-postgres"],
  poweredByHeader: false,
  // Développement : autorise aussi http://127.0.0.1:3000 (cookies séparés de localhost, pratique pour tester deux profils).
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
