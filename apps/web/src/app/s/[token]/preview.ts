import "server-only";
import { skillPublicPreviewSchema, type SkillPublicPreview } from "@companion/contracts";
import { apiBaseUrl } from "@/lib/apiServer";

export interface PublicReleasePreview {
  version: string;
  checksum: string;
  size_bytes: number;
  released_at: string;
}

/**
 * Keep the page tolerant while older Companion instances roll through the additive migration. The
 * public-release field is parsed here as well as by the shared contract so a mixed web/API deploy
 * never mistakes an internal current version for the pinned public release.
 */
export type PublicSkillPreview = SkillPublicPreview & {
  public_release: PublicReleasePreview | null;
};

const rollingPublicPreviewSchema = skillPublicPreviewSchema.extend({
  public_release: skillPublicPreviewSchema.shape.public_release.optional().default(null),
});

export async function fetchPublicSkillPreview(token: string): Promise<PublicSkillPreview | null> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/v1/public/skills/${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load public skill preview: ${res.status}`);
  const json = await res.json().catch(() => null);
  return rollingPublicPreviewSchema.parse(json);
}

export function skillShareGoHref(token: string): string {
  return `/s/${encodeURIComponent(token)}/go`;
}

export function skillDetailHrefForSlug(slug: string): string {
  return `/skills?lib=org&skill=${encodeURIComponent(slug)}`;
}

export function skillDetailHref(preview: PublicSkillPreview): string {
  return skillDetailHrefForSlug(preview.slug);
}

export function truncateMeta(value: string, max = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}
