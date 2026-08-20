"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button, EmptyState } from "@/components/cds";
import "./globals.css";

const NO_FOUC_SCRIPT = `(function(){try{var r=document.documentElement;var p={theme:"light",accent:"yellow"};try{var s=localStorage.getItem("sx_prefs");if(s){var o=JSON.parse(s);if(o){if(o.theme)p.theme=o.theme;if(o.accent)p.accent=o.accent;}}}catch(e){}var t=p.theme;if(t==="system")t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(t==="dark")r.setAttribute("data-theme","dark");else r.removeAttribute("data-theme");if(p.accent&&p.accent!=="yellow")r.setAttribute("data-accent",p.accent);else r.removeAttribute("data-accent");}catch(e){}})();`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const description = error.digest
    ? `Retry this page. If it keeps failing, share this code with an operator: ${error.digest}`
    : "Retry this page. If it keeps failing, try again in a moment.";

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Companion</title>
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: NO_FOUC_SCRIPT }} />
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
                    title="Something went wrong"
                    description={description}
                    action={
                      <Button type="button" variant="secondary" onClick={() => reset()}>
                        Retry
                      </Button>
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
