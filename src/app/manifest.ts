import type { MetadataRoute } from "next";

/** Manifeste d'application web : rend MAAQ installable sur l'écran d'accueil (US-1, US-2). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MAAQ",
    short_name: "MAAQ",
    description: "Vos agents IA pour l'administratif et le quotidien, en toute transparence.",
    lang: "fr",
    // `id` garde l'identité de l'application installée (c'était l'adresse de démarrage « / »). L'adresse de démarrage porte la marque d'un lancement depuis l'écran d'accueil :
    // elle sert quand le navigateur n'a créé qu'un raccourci, qui s'ouvre dans un onglet et non en mode installé (US-1 RF8).
    id: "/",
    scope: "/",
    start_url: "/?source=ecran-accueil",
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
