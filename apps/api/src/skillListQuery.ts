import { labelPathSchema } from "@companion/contracts";

export interface SkillListQuery {
  library: "org" | "mine";
  labelValid: boolean;
  label: string | undefined;
  nolabel: boolean;
  installedOnly: boolean;
  archived: boolean;
  query: string | undefined;
  limit: number | undefined;
}

export function parseSkillListQuery(read: (name: string) => string | undefined): SkillListQuery {
  const library = read("lib") === "mine" ? ("mine" as const) : ("org" as const);
  const labelRaw = read("label")?.trim();
  const query = read("q")?.trim() || undefined;
  return {
    library,
    labelValid: !labelRaw || labelPathSchema.safeParse(labelRaw).success,
    label: labelRaw || undefined,
    nolabel: read("nolabel") === "true",
    installedOnly: read("installed") === "true",
    archived: read("archived") === "true",
    query,
    limit: query ? 20 : undefined,
  };
}
