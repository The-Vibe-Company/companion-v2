import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { serverApiFetch } from "@/lib/apiServer";
import { Icon } from "@/components/Icon";
import { fetchPublicSkillPreview, skillShareGoHref, truncateMeta } from "./preview";

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

  const title = `${preview.display_name} · v${preview.current_version}`;
  const description = truncateMeta(preview.description);
  const url = `/s/${encodeURIComponent(token)}`;
  return {
    title,
    description,
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

  const viewParam = (await searchParams)?.view;
  const view = Array.isArray(viewParam) ? viewParam[0] : viewParam;
  const user = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  const goHref = skillShareGoHref(token);
  if (user && view !== "public") redirect(goHref);

  return (
    <main className="spage">
      <section className="spreview" aria-labelledby="share-skill-title">
        <div className="spreview__brand" aria-label="Companion">
          <span className="spreview__mark" />
          <span className="spreview__brandtext">Companion</span>
        </div>

        <p className="lin-eyebrow spreview__eyebrow">
          <Icon name="package" size={13} />
          Organization skill
        </p>
        <h1 id="share-skill-title" className="spreview__title">
          {preview.display_name}
        </h1>
        <p className="spreview__slug mono">{preview.slug}</p>
        <p className="spreview__desc">{preview.description}</p>

        <div className="spreview__facts" aria-label="Skill metadata">
          <span className="spreview__fact">
            <Icon name="tag" size={14} />
            v{preview.current_version}
          </span>
          <span className="spreview__fact">
            <span className="avatar" style={{ width: 22, height: 22, fontSize: 11 }}>
              {preview.creator_initials}
            </span>
            {preview.creator_name}
          </span>
        </div>

        <div className="spreview__actions">
          <Link className="btn-primary spreview__cta" href={goHref}>
            <Icon name="log-in" size={14} />
            View on Companion
          </Link>
        </div>
      </section>
    </main>
  );
}
