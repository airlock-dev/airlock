/** Keep the requested safety margin for long-lived tokens, but never consume a short token's life. */
export function adaptiveExpiryBuffer(lifetimeMs: number, maximumBufferMs: number): number {
  // Refresh at 90% of the declared lifetime when the usual fixed buffer would be too large.
  // A fixed five-minute buffer made five-minute Linear tokens immediately eligible for another
  // refresh, producing a five-second refresh-token rotation loop.
  return Math.min(maximumBufferMs, lifetimeMs * 0.1);
}
