export const MOBILE_AUTH_SCHEMES = [
  "dev.companion.mobile",
  "dev.companion.mobile.dev",
] as const;

export function mobileAuthOrigins(environment = process.env.NODE_ENV): string[] {
  const schemes = environment === "production"
    ? MOBILE_AUTH_SCHEMES.slice(0, 1)
    : MOBILE_AUTH_SCHEMES;
  return schemes.flatMap((scheme) => [`${scheme}://`, `${scheme}://*`]);
}
