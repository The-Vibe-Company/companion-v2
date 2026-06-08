"use client";

import { useRouter } from "next/navigation";
import { Button, EmptyState } from "@/components/cds";

export function WorkspaceLoadError() {
  const router = useRouter();
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
                title="Couldn't load workspace"
                description="Refresh the page to try again. If the problem continues, check that the API and database are reachable."
                action={
                  <Button type="button" variant="secondary" onClick={() => router.refresh()}>
                    Retry
                  </Button>
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
