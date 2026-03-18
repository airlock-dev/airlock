import { matches } from '../allowlist/pattern.js';
import type { AgentConfig, SandboxConfig, SandboxOverrideConfig } from '../config/schema.js';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export interface ResolvedSandboxConfig {
  filesystem: {
    allow_write: string[];
    deny_read: string[];
    deny_write: string[];
    allow_read?: string[];
  };
  network: {
    allowed_domains: string[];
    denied_domains: string[];
  };
}

export interface SandboxDisplayInfo {
  enabled: boolean;
  presets: string[];
  toolPresets: string[];
  summary: string[];
  config?: ResolvedSandboxConfig;
}

function summarizeSandbox(config: ResolvedSandboxConfig): string[] {
  const summary: string[] = [];
  summary.push(
    config.network.allowed_domains.length === 0
      ? 'network:none'
      : `network:${config.network.allowed_domains.join(',')}`
  );

  if (config.filesystem.allow_write.length > 0) {
    summary.push(`write:${config.filesystem.allow_write.join(',')}`);
  }
  if (config.filesystem.allow_read && config.filesystem.allow_read.length > 0) {
    summary.push(`read:${config.filesystem.allow_read.join(',')}`);
  }
  if (config.filesystem.deny_read.length > 0) {
    summary.push(`deny-read:${config.filesystem.deny_read.join(',')}`);
  }

  return summary;
}

export function getSandboxDisplayInfo(
  agentConfig: AgentConfig,
  toolName: string,
  resolved?: ResolvedSandboxConfig
): SandboxDisplayInfo | undefined {
  if (!agentConfig.sandbox.enabled || !resolved) return undefined;

  const toolOverride = agentConfig.tool_overrides[toolName];
  const presets = agentConfig.sandbox.presets ?? [];
  const toolPresets = toolOverride?.sandbox_presets ?? [];

  return {
    enabled: true,
    presets,
    toolPresets,
    summary: summarizeSandbox(resolved),
    config: resolved,
  };
}

/**
 * Resolve the effective sandbox config for a tool call.
 * Merges base agent sandbox config with the most specific matching override.
 * Also checks tool_overrides for alias-specific sandbox config.
 */
export function resolveSandboxConfig(
  sandboxConfig: SandboxConfig,
  toolName: string,
  toolOverrideSandbox?: SandboxOverrideConfig
): ResolvedSandboxConfig {
  const base: ResolvedSandboxConfig = {
    filesystem: { ...sandboxConfig.filesystem },
    network: { ...sandboxConfig.network },
  };

  // Find matching overrides from sandbox.overrides, most specific wins
  // (exact match > longer prefix > shorter prefix)
  const matchingOverrides = Object.entries(sandboxConfig.overrides)
    .filter(([pattern]) => matches(pattern, toolName))
    .sort((a, b) => b[0].length - a[0].length); // longer patterns first

  if (matchingOverrides.length > 0) {
    mergeOverride(base, matchingOverrides[0][1]);
  }

  // Tool-specific sandbox from tool_overrides (alias) takes highest priority
  if (toolOverrideSandbox) {
    mergeOverride(base, toolOverrideSandbox);
  }

  return base;
}

function mergeOverride(base: ResolvedSandboxConfig, override: SandboxOverrideConfig): void {
  if (override.filesystem) {
    // allow_write replaces (the tool flavor defines its own restrictions)
    if (override.filesystem.allow_write !== undefined) {
      base.filesystem.allow_write = override.filesystem.allow_write;
    }
    // deny_read is additive
    if (override.filesystem.deny_read !== undefined) {
      base.filesystem.deny_read = [...base.filesystem.deny_read, ...override.filesystem.deny_read];
    }
    // deny_write is additive
    if (override.filesystem.deny_write !== undefined) {
      base.filesystem.deny_write = [
        ...base.filesystem.deny_write,
        ...override.filesystem.deny_write,
      ];
    }
    // allow_read replaces
    if (override.filesystem.allow_read !== undefined) {
      base.filesystem.allow_read = override.filesystem.allow_read;
    }
  }
  if (override.network) {
    // allowed_domains replaces
    if (override.network.allowed_domains !== undefined) {
      base.network.allowed_domains = override.network.allowed_domains;
    }
    // denied_domains is additive
    if (override.network.denied_domains !== undefined) {
      base.network.denied_domains = [
        ...base.network.denied_domains,
        ...override.network.denied_domains,
      ];
    }
  }
}

/**
 * Convert a ResolvedSandboxConfig into a SandboxRuntimeConfig suitable for
 * the @anthropic-ai/sandbox-runtime SandboxManager.
 */
export function toSandboxRuntimeConfig(config: ResolvedSandboxConfig): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: config.filesystem.allow_write,
      denyRead: config.filesystem.deny_read,
      denyWrite: config.filesystem.deny_write,
      ...(config.filesystem.allow_read ? { allowRead: config.filesystem.allow_read } : {}),
    },
    network: {
      allowedDomains: config.network.allowed_domains,
      deniedDomains: config.network.denied_domains,
    },
  };
}

async function ensureSandboxRuntime(config: SandboxRuntimeConfig): Promise<void> {
  if (
    typeof SandboxManager.isSupportedPlatform === 'function' &&
    !SandboxManager.isSupportedPlatform()
  ) {
    throw new Error('Sandbox runtime is not supported on this platform');
  }

  const canInitialize = typeof SandboxManager.initialize === 'function';
  const isEnabled =
    typeof SandboxManager.isSandboxingEnabled === 'function'
      ? SandboxManager.isSandboxingEnabled()
      : false;

  if (canInitialize && !isEnabled) {
    await SandboxManager.initialize(config);
    return;
  }

  if (typeof SandboxManager.updateConfig === 'function') {
    SandboxManager.updateConfig(config);
  }

  if (typeof SandboxManager.waitForNetworkInitialization === 'function') {
    const ready = await SandboxManager.waitForNetworkInitialization();
    if (!ready && canInitialize) {
      await SandboxManager.initialize(config);
    }
    return;
  }

  if (canInitialize) {
    await SandboxManager.initialize(config);
  }
}

/**
 * Wraps a shell command using the SandboxManager programmatic API.
 * Returns the wrapped command string that includes sandbox restrictions.
 */
export async function wrapCommandWithSandbox(
  command: string,
  sandbox: ResolvedSandboxConfig
): Promise<string> {
  const runtimeConfig = toSandboxRuntimeConfig(sandbox);
  await ensureSandboxRuntime(runtimeConfig);
  return SandboxManager.wrapWithSandbox(command, undefined, runtimeConfig);
}
