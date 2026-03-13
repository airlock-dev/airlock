/**
 * Check if a hostname is blocked.
 * Supports: exact match, *.prefix (subdomains), 10.* / 192.168.* / 172.16.* CIDR-like patterns.
 */
export function isBlockedHost(
  hostname: string,
  blockedList: string[],
  allowedLocal: string[]
): boolean {
  // If explicitly allowed, override block
  if (allowedLocal.some((p) => hostPatternMatches(p, hostname))) return false;

  return blockedList.some((p) => hostPatternMatches(p, hostname));
}

function hostPatternMatches(pattern: string, hostname: string): boolean {
  if (pattern === hostname) return true;

  // *.local style — matches subdomains only, not the apex
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname.endsWith('.' + suffix);
  }

  // CIDR-like: 192.168.* , 10.* , 172.16.*
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return hostname.startsWith(prefix);
  }

  return false;
}
