const INTERNAL_PRODUCT_DOMAIN = "thevibecompany.co";

/**
 * Restrict unreleased product surfaces to the exact internal email domain.
 *
 * This deliberately validates the address before comparing its domain so suffixes,
 * subdomains, whitespace, and multiple-`@` lookalikes fail closed.
 */
export function hasInternalProductAccess(email: string | null | undefined): boolean {
  if (
    typeof email !== "string"
    || email.length === 0
    || email.length > 254
    || email !== email.trim()
  ) {
    return false;
  }

  const parts = email.split("@");
  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  if (
    !local
    || local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
  ) {
    return false;
  }

  return domain !== undefined && domain.toLowerCase() === INTERNAL_PRODUCT_DOMAIN;
}
