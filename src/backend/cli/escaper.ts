export function escapeShellArg(value: string): string {
  if (value.includes('\0')) {
    throw new Error('Shell argument must not contain null bytes');
  }
  // Wrap in single quotes; escape internal single quotes as '\''
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
