import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { fetchPublicSkillPreview, truncateMeta } from "./preview";

export const runtime = "nodejs";
export const alt = "Companion skill preview";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function loadBrandMark(): Promise<string | null> {
  try {
    const data = await readFile(join(process.cwd(), "public", "brand", "companion-mark.png"));
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function SkillOpenGraphImage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [preview, mark] = await Promise.all([
    fetchPublicSkillPreview(token),
    loadBrandMark(),
  ]);
  const title = preview?.display_name ?? "Skill not found";
  const slug = preview?.slug ?? "companion";
  const description = preview ? truncateMeta(preview.description, 170) : "This Companion skill preview is unavailable.";
  const version = preview?.current_version ? `v${preview.current_version}` : "Companion";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f7f7f9",
          color: "#34313c",
          padding: 72,
          fontFamily: "Arial",
          border: "1px solid #d9d6df",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            {mark ? (
              <img
                src={mark}
                width={54}
                height={54}
                alt=""
                style={{ borderRadius: 12, border: "1px solid #d9d6df", background: "#ffffff" }}
              />
            ) : (
              <div style={{ width: 54, height: 54, borderRadius: 12, background: "#ffffff", border: "1px solid #d9d6df" }} />
            )}
            <div style={{ fontSize: 30, fontWeight: 700 }}>Companion</div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: 48,
              padding: "0 20px",
              borderRadius: 12,
              background: "#efe7bd",
              color: "#3f3515",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            {version}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ fontSize: 26, color: "#787182" }}>{slug}</div>
          <div style={{ fontSize: 76, lineHeight: 0.95, fontWeight: 800, maxWidth: 900 }}>{title}</div>
          <div style={{ fontSize: 30, lineHeight: 1.35, color: "#5f5968", maxWidth: 880 }}>{description}</div>
        </div>

        <div style={{ display: "flex", gap: 18, color: "#787182", fontSize: 24 }}>
          {preview ? <div>{`By ${preview.creator_name}`}</div> : null}
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
