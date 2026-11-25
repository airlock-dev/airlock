import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Check if a hostname is blocked.
 * Supports: exact match, *.prefix (subdomains), 10.* / 192.168.* / 172.16.* CIDR-like patterns.
 */
export function isBlockedHost(
  hostname: string,
  blockedList: string[],
  allowedLocal: string[]
): boolean {
  const normalizedHostname = normalizeHostname(hostname);

  // If explicitly allowed, override block
  if (allowedLocal.some((p) => hostPatternMatches(p, normalizedHostname))) return false;

  return blockedList.some((p) => hostPatternMatches(p, normalizedHostname));
}

export async function assertHostNotBlocked(
  hostname: string,
  blockedList: string[],
  allowedLocal: string[]
): Promise<string> {
  const normalizedHostname = normalizeHostname(hostname);

  if (isBlockedHost(normalizedHostname, blockedList, allowedLocal)) {
    throw new Error(`Blocked host: ${normalizedHostname}`);
  }

  if (isIP(normalizedHostname) !== 0 || allowedLocal.some((p) => hostPatternMatches(p, normalizedHostname))) {
    return normalizedHostname;
  }

  try {
    const addresses = await lookup(normalizedHostname, { all: true, verbatim: true });
    for (const { address } of addresses) {
      const normalizedAddress = normalizeHostname(address);
      if (isBlockedHost(normalizedAddress, blockedList, allowedLocal)) {
        throw new Error(`Blocked host: ${normalizedHostname} resolved to ${normalizedAddress}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Blocked host:')) throw err;
    throw new Error(`Could not verify host: ${normalizedHostname}`, { cause: err });
  }

  return normalizedHostname;
}

export function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  return normalizeIpv4MappedIpv6(normalized);
}

function hostPatternMatches(pattern: string, hostname: string): boolean {
  const normalizedPattern = normalizeHostname(pattern);
  if (normalizedPattern === hostname) return true;

  // *.local style — matches subdomains only, not the apex
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return hostname.endsWith('.' + suffix);
  }

  // CIDR-like: 192.168.* , 10.* , 172.16.*
  if (normalizedPattern.endsWith('*')) {
    const prefix = normalizedPattern.slice(0, -1);
    return hostname.startsWith(prefix);
  }

  return false;
}

function normalizeIpv4MappedIpv6(hostname: string): string {
  if (!hostname.startsWith('::ffff:')) return hostname;

  const suffix = hostname.slice('::ffff:'.length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) return suffix;

  const parts = suffix.split(':');
  if (parts.length !== 2) return hostname;

  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return hostname;
  }

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}
