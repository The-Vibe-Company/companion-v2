"use client";

import { useRouter } from "next/navigation";
import { Button, EmptyState } from "@/components/cds";

export function RetryButton() {
  const router = useRouter();
  return (
    <Button type="button" variant="secondary" onClick={() => router.refresh()}>
      Retry
    </Button>
  );
}

export function WorkspaceLoadError({
  title = "Couldn't load workspace",
  description = "Refresh the page to try again. If the problem continues, check that the API and database are reachable.",
}: {
  title?: string;
  description?: string;
} = {}) {
  return (
    <div className="app">
      <div className="main">
        <div className="og-set">
          <div className="og-set__top">
            <div className="og-set__crumb">
              <b>Companion</b>
            </div>
          </div>
          <div className="og-pane">
            <div className="og-pane__inner">
              <EmptyState
                title={title}
                description={description}
                action={<RetryButton />}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AuthUnavailable() {
  return (
    <WorkspaceLoadError
      title="Couldn't verify your session"
      description="Companion is temporarily unavailable. Retry in a moment; your sign-in has not been cleared."
    />
  );
}
