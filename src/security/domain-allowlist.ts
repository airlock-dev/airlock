/**
 * Check if a hostname is permitted by the agent's domain allowlist.
 * Empty allowlist = allow all.
 * Supports *.sentry.io style wildcards.
 */
export function isDomainAllowed(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;

  return allowlist.some(pattern => {
    if (pattern === hostname) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return hostname === suffix || hostname.endsWith('.' + suffix);
    }
    return false;
  });
}
