import { ImageResponse } from "next/og";

export const alt = "enwise | invoicing from inside Claude";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#0a0a0a",
          padding: "0 96px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg
            width={64}
            height={64}
            viewBox="0 0 256 256"
            fill="none"
            style={{ display: "flex" }}
          >
            <g
              stroke="#fafafa"
              strokeWidth={22}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            >
              <circle cx={176} cy={128} r={48} />
              <path d="M 56 128 L 128 128" />
            </g>
          </svg>
          <div style={{ fontSize: 40, fontWeight: 700, color: "#fafafa", display: "flex" }}>
            enwise
          </div>
        </div>

        <div
          style={{
            marginTop: 48,
            fontSize: 68,
            fontWeight: 700,
            color: "#fafafa",
            lineHeight: 1.1,
            display: "flex",
          }}
        >
          Create invoices with AI.
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 32,
            color: "#a1a1aa",
            maxWidth: 920,
            lineHeight: 1.4,
            display: "flex",
          }}
        >
          Bill clients, send invoices, and accept payments, right inside Claude.
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 64,
            right: 96,
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#52525b",
            display: "flex",
          }}
        >
          enwise.app
        </div>
      </div>
    ),
    { ...size },
  );
}
