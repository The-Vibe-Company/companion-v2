import type { Hono } from "hono";
import { companionsEnabled } from "@companion/core";
import {
  actorFromContext,
  jsonError,
  orgIdFromContext,
  type ApiVariables,
} from "./context";

export function registerCompanionRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!companionsEnabled(env)) return;

  app.get("/v1/companions", async (c) => {
    try {
      actorFromContext(c);
    } catch (error) {
      return jsonError(c, error, 401);
    }

    try {
      await orgIdFromContext(c);
      return c.json({ companions: [] });
    } catch (error) {
      return jsonError(c, error, 403);
    }
  });
}
