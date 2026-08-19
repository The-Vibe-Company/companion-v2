"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

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

  return (
    <html>
      <body className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <h2 className="mb-4 text-xl font-semibold">An unexpected error occurred</h2>
        <button
          onClick={() => reset()}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none"
        >
          Try again
        </button>
      </body>
    </html>
  );
}

