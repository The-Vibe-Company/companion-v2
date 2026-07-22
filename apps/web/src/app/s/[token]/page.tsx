import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApiFetch } from "@/lib/apiServer";
import { Icon } from "@/components/Icon";
import { fetchPublicSkillPreview, skillShareGoHref, truncateMeta } from "./preview";
import { PublicSkillActions } from "./PublicSkillActions";
import { formatBytes, formatDate } from "@/lib/format";

type ShareParams = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: ShareParams): Promise<Metadata> {
  const { token } = await params;
  const preview = await fetchPublicSkillPreview(token);
  if (!preview) {
    return {
      title: "Skill not found · Companion",
      description: "This Companion skill preview is unavailable.",
      robots: { index: false, follow: false },
    };
  }

  const version = preview.public_release?.version ?? preview.current_version;
  const title = `${preview.display_name} · ${preview.public_release ? "Public " : ""}v${version}`;
  const description = truncateMeta(preview.description);
  const url = `/s/${encodeURIComponent(token)}`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Companion",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function SkillSharePage({ params, searchParams }: ShareParams) {
  const { token } = await params;
  const preview = await fetchPublicSkillPreview(token);
  if (!preview) notFound();

  const downloadParam = (await searchParams)?.download;
  const startDownload = (Array.isArray(downloadParam) ? downloadParam[0] : downloadParam) === "1";
  const user = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  const goHref = skillShareGoHref(token);
  const release = preview.public_release;

  return (
    <main className="spage">
      <section className="spreview" aria-labelledby="share-skill-title">
        <header className="spreview__topbar">
          <div className="spreview__brand" aria-label="Companion">
            <span className="spreview__mark" />
            <span className="spreview__brandtext">Companion</span>
          </div>
          <Link className="btn-ghost spreview__open" href={goHref}>
            <Icon name="arrow-right" size={14} />
            Open in Companion
          </Link>
        </header>

        <div className="spreview__body">
          <p className="lin-eyebrow spreview__eyebrow">
            <Icon name="package" size={13} />
            Organization skill
          </p>
          <div className="spreview__heading">
            <h1 id="share-skill-title" className="spreview__title">
              {preview.display_name}
            </h1>
            <span className={`spreview__release-badge${release ? " is-public" : ""}`}>
              {release ? `Public v${release.version}` : "Metadata only"}
            </span>
          </div>
          <p className="spreview__slug mono">{preview.slug}</p>
          <p className="spreview__desc">{preview.description}</p>

          <dl className="spreview__facts" aria-label="Skill metadata">
            <div className="spreview__fact">
              <dt>Creator</dt>
              <dd>
                <span className="avatar" style={{ width: 22, height: 22, fontSize: 11 }}>
                  {preview.creator_initials}
                </span>
                {preview.creator_name}
              </dd>
            </div>
            {release ? (
              <>
                <div className="spreview__fact">
                  <dt>Package</dt>
                  <dd>{formatBytes(release.size_bytes)}</dd>
                </div>
                <div className="spreview__fact">
                  <dt>Released</dt>
                  <dd>{formatDate(release.released_at)}</dd>
                </div>
                <div className="spreview__fact spreview__fact--checksum">
                  <dt>SHA-256</dt>
                  <dd className="mono" title={release.checksum}>
                    {release.checksum}
                  </dd>
                </div>
              </>
            ) : (
              <div className="spreview__fact">
                <dt>Updated</dt>
                <dd>{formatDate(preview.updated_at)}</dd>
              </div>
            )}
          </dl>

          <PublicSkillActions
            token={token}
            slug={preview.slug}
            release={release}
            authenticated={Boolean(user)}
            startDownload={startDownload}
          />
        </div>

        <footer className="spreview__footer">
          <span>
            <Icon name="shield-check" size={14} />
            Package access requires a verified account or approved agent.
          </span>
          <span className="mono">
            {preview.slug}{release ? `@${release.version}` : ""}
          </span>
        </footer>
      </section>
    </main>
  );
}
