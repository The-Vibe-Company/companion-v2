import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The Companion skill install is no longer a hard gate (the dismissible install dialog now lives inside
 * the Companion skills view). This route is kept only so older links still land somewhere sensible.
 */
export default function CompanionSetupPage() {
  redirect("/skills?view=local");
}
