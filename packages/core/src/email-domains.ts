import freeEmailDomains from "free-email-domains";

/**
 * Identifying a "personal"/free email provider programmatically.
 *
 * There is no reliable DNS/MX signal that separates a corporate domain from a free one
 * (Google Workspace tenants share Gmail's MX; consumer Gmail is just `gmail.com`). The
 * de-facto industry approach is a maintained free-provider blocklist. We use the
 * `free-email-domains` package (a static list of ~4,800 providers) — pure data, no network,
 * which keeps onboarding offline-first and never executes untrusted code.
 *
 * Known limitation: vanity subdomains of free providers (e.g. `you@mail.gmail.com`) are not
 * matched. Augmenting with a disposable-domain list is a future addition.
 */
const PERSONAL_DOMAINS: ReadonlySet<string> = new Set(freeEmailDomains.map((d) => d.toLowerCase()));

export interface EmailDomainClassification {
  /** The normalized domain part (lowercased, trimmed), or null when the address is malformed. */
  domain: string | null;
  /** True when the domain is a known free/consumer provider (so no corporate org can be inferred). */
  isPersonal: boolean;
}

/** Extract and normalize the domain after the last `@`, then test it against the free-provider list. */
export function classifyEmailDomain(email: string): EmailDomainClassification {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return { domain: null, isPersonal: false };
  let domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (!domain) return { domain: null, isPersonal: false };
  return { domain, isPersonal: PERSONAL_DOMAINS.has(domain) };
}

/** True for a domain we can reasonably treat as a corporate/organizational domain. */
export function isCorporateDomain(email: string): boolean {
  const { domain, isPersonal } = classifyEmailDomain(email);
  return domain != null && !isPersonal;
}
