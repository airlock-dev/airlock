/** Tool naming conventions shared by the registry, the transports and the approval engine. */

/** The provider a namespaced tool ("provider/tool") belongs to. */
export function providerIdForTool(toolName: string): string {
  const separatorIndex = toolName.indexOf('/');
  return separatorIndex > 0 ? toolName.slice(0, separatorIndex) : toolName;
}

/**
 * MCP tool name pattern: ^[a-zA-Z0-9_-]{1,64}$. Airlock namespaces tools as "provider/toolName",
 * which contains '/', so '/' becomes '_' at the protocol boundary so all clients accept the names.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/\//g, '_');
}
