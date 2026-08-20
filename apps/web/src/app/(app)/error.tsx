"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button, EmptyState } from "@/components/cds";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
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
                description="Retry the request. If it keeps failing, check the server logs for the request."
                action={
                  <Button type="button" variant="secondary" onClick={reset}>
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
