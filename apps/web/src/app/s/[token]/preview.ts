import "server-only";
import { skillPublicPreviewSchema, type SkillPublicPreview } from "@companion/contracts";
import { apiBaseUrl } from "@/lib/apiServer";

export async function fetchPublicSkillPreview(token: string): Promise<SkillPublicPreview | null> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/v1/public/skills/${encodeURIComponent(token)}`, {
      next: { revalidate: 300 },
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load public skill preview: ${res.status}`);
  const json = await res.json().catch(() => null);
  return skillPublicPreviewSchema.parse(json);
}

export function skillShareGoHref(token: string): string {
  return `/s/${encodeURIComponent(token)}/go`;
}

export function skillDetailHrefForSlug(slug: string): string {
  return `/skills?lib=org&skill=${encodeURIComponent(slug)}`;
}

export function skillDetailHref(preview: SkillPublicPreview): string {
  return skillDetailHrefForSlug(preview.slug);
}

export function truncateMeta(value: string, max = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}
