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
          <div
            style={{
              position: "relative",
              width: 64,
              height: 64,
              display: "flex",
            }}
          >
            <div
              style={{
                position: "absolute",
                right: 0,
                top: 8,
                width: 48,
                height: 48,
                borderRadius: 999,
                border: "6px solid #fafafa",
                display: "flex",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 29,
                width: 26,
                height: 6,
                borderRadius: 3,
                background: "#fafafa",
                display: "flex",
              }}
            />
          </div>
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
