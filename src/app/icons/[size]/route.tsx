import { ImageResponse } from "next/og";

const SIZES = new Set([180, 192, 512]);

/** Icône de l'application (le « M » bordeaux des maquettes), générée en PNG. */
export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response(null, { status: 404 });
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
          fontSize: size * 0.46,
          fontWeight: 600,
          fontFamily: "serif",
        }}
      >
        M
      </div>
    ),
    { width: size, height: size },
  );
}
