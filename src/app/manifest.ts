import type { MetadataRoute } from "next";

/** Manifeste d'application web : rend MAAQ installable sur l'écran d'accueil (US-1, US-2). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MAAQ",
    short_name: "MAAQ",
    description: "Vos agents IA pour l'administratif et le quotidien, en toute transparence.",
    lang: "fr",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#e9e1d2",
    theme_color: "#7a2e32",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png" },
      { src: "/icons/512", sizes: "512x512", type: "image/png" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
