import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/client";
import * as SecureStore from "expo-secure-store";

import { apiUrl } from "./api";

export const authClient = createAuthClient({
  baseURL: `${apiUrl}/auth`,
  plugins: [
    expoClient({
      storage: SecureStore,
      storagePrefix: "companion_native_google",
      // The array keeps the empty prefix truthy inside @better-auth/expo 1.6.x; its matcher then
      // accepts any Better Auth session suffix despite Conductor's workspace-specific prefix.
      cookiePrefix: [""],
      disableCache: true,
    }),
  ],
});

export async function clearGoogleAuthSession(): Promise<void> {
  // The Expo client clears its local cookie before performing the best-effort server request.
  await authClient.signOut().catch(() => undefined);
}
