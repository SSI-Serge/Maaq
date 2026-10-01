import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Karla, Newsreader } from "next/font/google";
import { AppBoot } from "@/components/AppBoot";
import { OfflineBanner } from "@/components/OfflineBanner";
import "./globals.css";

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
});
const karla = Karla({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-karla" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "MAAQ",
  description: "Vos agents IA pour l'administratif et le quotidien, en toute transparence.",
  applicationName: "MAAQ",
  appleWebApp: { capable: true, title: "MAAQ", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#7a2e32",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${newsreader.variable} ${karla.variable} ${plexMono.variable}`}>
      <body>
        <AppBoot />
        <OfflineBanner />
        {children}
      </body>
    </html>
  );
}
