import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Icône de l'écran d'accueil iPhone. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#7a2e32",
          color: "#f7f1e6",
          fontSize: 84,
          fontWeight: 600,
          fontFamily: "serif",
        }}
      >
        M
      </div>
    ),
    size,
  );
}
