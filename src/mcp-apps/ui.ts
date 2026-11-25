/**
 * MCP Apps (`io.modelcontextprotocol/ui`, spec 2026-01-26) passthrough.
 *
 * An MCP Apps server attaches an HTML view to a tool: the tool carries
 * `_meta.ui.resourceUri: "ui://…"`, the host fetches that resource with `resources/read`, and
 * renders it in a sandboxed iframe. The view can call tools back through the host.
 *
 * Airlock sits between the host and many upstreams, so it has to:
 * - advertise the extension upstream, or spec-following servers register no UI tools at all;
 * - namespace `ui://` URIs per provider (two upstreams may both ship `ui://dashboard`) and route
 *   `resources/read` back to the provider that owns the URI;
 * - only serve a view for a tool the agent can see, so a denied tool's UI is not reachable either;
 * - hide app-only tools (`visibility: ["app"]`) from a host that does not support MCP Apps, since
 *   such a host would otherwise hand them to the model.
 *
 * What this does NOT do is tell a view's call apart from a model's: both arrive as `tools/call` over
 * the same connection. Every call, whoever made it, goes through the same allow/ask/deny policy, so
 * an action that needs a human must be under `ask` and is approved out of band, never by a button
 * inside the view.
 */

import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import type { ClientCapabilities } from '@modelcontextprotocol/server';
import { isRecord } from '../util/is-record.js';

export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
const UI_SCHEME = 'ui://';
/** Deprecated flat form of `_meta.ui.resourceUri`, still emitted by older servers. */
const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri';
/** Airlock-owned authority under which upstream `ui://` URIs are namespaced. */
const NAMESPACE_PREFIX = 'ui://airlock/';
/** Prefix of `_meta` keys the MCP spec reserves for the protocol itself. */
const RESERVED_META_PREFIX = 'io.modelcontextprotocol/';

export type UiVisibility = 'model' | 'app';

/**
 * Capabilities Airlock declares to an upstream MCP server. MCP Apps support is only declared for a
 * provider that opted in (`mcp_apps: true`), so other providers register no UI tools at all.
 */
export function upstreamClientCapabilities(mcpApps: boolean): ClientCapabilities {
  return mcpApps ? { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } } : {};
}

interface WithMeta {
  _meta?: Record<string, unknown>;
}

function uiMeta(tool: WithMeta): Record<string, unknown> | undefined {
  const ui = tool._meta?.ui;
  return isRecord(ui) ? ui : undefined;
}

/** The `ui://` resource a tool renders, from `_meta.ui.resourceUri` or the deprecated flat key. */
export function toolUiResourceUri(tool: WithMeta): string | undefined {
  const candidate = uiMeta(tool)?.resourceUri ?? tool._meta?.[LEGACY_RESOURCE_URI_KEY];
  return typeof candidate === 'string' && candidate.startsWith(UI_SCHEME) ? candidate : undefined;
}

/** Who may call a tool. Defaults to both, per spec; an unusable value falls back to the default. */
export function toolVisibility(tool: WithMeta): UiVisibility[] {
  const raw = uiMeta(tool)?.visibility;
  if (!Array.isArray(raw)) return ['model', 'app'];
  const valid = raw.filter((v): v is UiVisibility => v === 'model' || v === 'app');
  return valid.length > 0 ? valid : ['model', 'app'];
}

/** Whether a tool is meant for the view only, never for the model. */
export function isAppOnlyTool(tool: WithMeta): boolean {
  return !toolVisibility(tool).includes('model');
}

/**
 * Whether the host renders MCP Apps: true or false when it said, undefined when it is not known.
 *
 * A 2026-07-28 request carries the client's capabilities in its envelope; a stateful 2025
 * session has them from `initialize`. A 2025 client over stateless HTTP has neither on hand.
 */
export function hostSupportsUi(
  requestEnvelope: Record<string, unknown> | undefined,
  sessionCapabilities: Record<string, unknown> | undefined
): boolean | undefined {
  // The SDK lifts the reserved envelope keys off a request's `_meta` into the envelope.
  const capabilities = requestEnvelope?.[CLIENT_CAPABILITIES_META_KEY] ?? sessionCapabilities;
  if (!isRecord(capabilities)) return undefined;
  const extensions = capabilities.extensions;
  const ui = isRecord(extensions) ? extensions[UI_EXTENSION_ID] : undefined;
  if (!isRecord(ui)) return false;
  // `mimeTypes` is required; tolerate a host that omits it rather than refuse it the views.
  return !Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(UI_MIME_TYPE);
}

/** `ui://weather/dash` from provider `wx` becomes `ui://airlock/wx/weather/dash`. */
export function namespaceUiUri(providerId: string, upstreamUri: string): string {
  return `${NAMESPACE_PREFIX}${encodeURIComponent(providerId)}/${upstreamUri.slice(UI_SCHEME.length)}`;
}

/** Inverse of {@link namespaceUiUri}; undefined for a URI Airlock did not mint. */
export function parseNamespacedUiUri(
  uri: string
): { providerId: string; upstreamUri: string } | undefined {
  if (!uri.startsWith(NAMESPACE_PREFIX)) return undefined;
  const rest = uri.slice(NAMESPACE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  let providerId: string;
  try {
    providerId = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return undefined;
  }
  return { providerId, upstreamUri: `${UI_SCHEME}${rest.slice(slash + 1)}` };
}

/**
 * The tool with its `ui://` reference namespaced under its provider. The deprecated flat key is
 * rewritten too, so a host reading either form lands on a URI Airlock can route.
 */
export function namespaceToolUiMeta<T extends WithMeta>(tool: T, providerId: string): T {
  const meta = tool._meta;
  if (!meta) return tool;
  const next: Record<string, unknown> = { ...meta };
  let changed = false;

  const ui = uiMeta(tool);
  if (ui && typeof ui.resourceUri === 'string' && ui.resourceUri.startsWith(UI_SCHEME)) {
    next.ui = { ...ui, resourceUri: namespaceUiUri(providerId, ui.resourceUri) };
    changed = true;
  }
  const legacy = meta[LEGACY_RESOURCE_URI_KEY];
  if (typeof legacy === 'string' && legacy.startsWith(UI_SCHEME)) {
    next[LEGACY_RESOURCE_URI_KEY] = namespaceUiUri(providerId, legacy);
    changed = true;
  }
  return changed ? { ...tool, _meta: next } : tool;
}

/**
 * The tool without any MCP Apps metadata, for a provider that did not opt in: no view reference
 * reaches the host, so the host treats it as a plain tool.
 */
export function stripToolUiMeta<T extends WithMeta>(tool: T): T {
  const meta = tool._meta;
  if (!meta || (!('ui' in meta) && !(LEGACY_RESOURCE_URI_KEY in meta))) return tool;
  const { ui: _ui, [LEGACY_RESOURCE_URI_KEY]: _legacy, ...rest } = meta;
  const { _meta: _dropped, ...withoutMeta } = tool;
  return (Object.keys(rest).length > 0 ? { ...withoutMeta, _meta: rest } : withoutMeta) as T;
}

/**
 * An upstream result's `_meta` as it may be handed to a view: the spec-reserved protocol keys are
 * Airlock's to set on its own responses, never an upstream's. Undefined when nothing is left.
 */
export function viewResultMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isRecord(meta)) return undefined;
  const kept = Object.entries(meta).filter(([key]) => !key.startsWith(RESERVED_META_PREFIX));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}
