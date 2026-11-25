import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClientPool } from './pool/pool.js';
import { eventEnabledProviders, requiredMcpsForAgent } from './pool/required-mcps.js';
import { ToolRegistry } from './registry/registry.js';
import { AllowlistEngine } from './allowlist/engine.js';
import { EventRegistry } from './events/registry.js';
import { EventStreamManager } from './events/stream-manager.js';
import { EventService } from './events/service.js';
import { resolveLimits } from './transport/session-limiter.js';
import { HitlEngine } from './hitl/engine.js';
import { HitlBatcher } from './hitl/batcher.js';
import { createGrantStore, engineOptionsFromConfig, wireBatcher } from './hitl/runtime.js';
import { AuditLogger } from './audit/logger.js';
import { hitlApiPlugin } from './hitl/api.js';
import { auditApiPlugin } from './audit/api.js';
import { mobileApiPlugin } from './mobile/api.js';
import { ApprovalStreamHub } from './hitl/approval-stream.js';
import { ApprovalDashboardRoutes } from './hitl/approval-dashboard.js';
import { ApprovalPreviewReader } from './hitl/preview.js';
import { createHitlProvider } from './hitl/provider-factory.js';
import { CompositeHitlProvider } from './hitl/providers/composite.js';
import { runStdioServer } from './transport/stdio-server.js';
import { ConfigWatcher } from './config/watcher.js';
import type { Config } from './config/loader.js';
import type { ApprovalApi } from './hitl/providers/types.js';
import { getBuiltinProviders, getMcpConfigs, getProviderInstructions } from './config/schema.js';
import { buildAdapters } from './backend/factory.js';
import { ActivityStream } from './activity/stream.js';
import { checkRequestSecurity, type RequestSecurityOptions } from './security/request.js';
import { childLogger } from './util/logger.js';
import { SHUTDOWN_FORCE_EXIT_MS } from './pool/oauth-refresh.js';
import { uploadsApiPlugin } from './uploads/api.js';
import { UploadStore } from './uploads/store.js';

const log = childLogger('stdio-mode');

export async function runStdioMode(
  config: Config,
  agentId: string,
  configPath: string
): Promise<void> {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Unknown agent profile: ${agentId}`);
  }

  // Stdio mode uses stdin/stdout for MCP protocol — the stdio approval provider
  // also reads from stdin, which would corrupt the MCP transport.
  const providers = Array.isArray(config.approvals.provider)
    ? config.approvals.provider
    : [config.approvals.provider];
  if (providers.some((p) => p.type === 'stdio')) {
    throw new Error(
      'Cannot use approval provider "stdio" in stdio mode — both the MCP transport and approval ' +
        'provider would read from stdin. Use "dashboard", "macos", "telegram", "slack", "webhook", or "openclaw" instead.'
    );
  }

  log.info({ agentId }, 'Starting Airlock in stdio mode');
  const downstreamSessionId = randomUUID();

  let currentAgentConfig = agentConfig;

  // Audit
  const auditLogger = new AuditLogger(config.audit);
  auditLogger.startDailyCleanup();

  // Approvals — provider is created before engine, so forward calls via closure
  // eslint-disable-next-line prefer-const
  let hitlEngine!: HitlEngine;
  const approvalForwarder: ApprovalApi = {
    approve: (id, options) => hitlEngine.approve(id, options),
    deny: (id, reason) => hitlEngine.deny(id, reason),
    approveByCode: (code, options) => hitlEngine.approveByCode(code, options),
    denyByCode: (code, reason) => hitlEngine.denyByCode(code, reason),
    listGrants: (filterAgentId) => hitlEngine.listGrants(filterAgentId),
    revokeGrant: (id) => hitlEngine.revokeGrant(id),
  };

  const hitlBatcher = new HitlBatcher(config.approvals.batch_window_ms);
  const activityStream = new ActivityStream();
  const approvalStream = new ApprovalStreamHub({ activityStream });
  let activeConfig = config;
  const registryRef: { current?: ToolRegistry } = {};
  const approvalPreviews = new ApprovalPreviewReader({
    getHooks: () => activeConfig.approvals.previews ?? {},
    getRegistry: () => {
      if (!registryRef.current) throw new Error('Tool registry unavailable');
      return registryRef.current;
    },
    isPending: (id) => hitlEngine.hasPending(id),
    getRequest: (id) => hitlEngine.getPreviewRequest(id),
    auditLogger,
  });
  const configuredHitlProvider = createHitlProvider(config.approvals.provider, approvalForwarder, {
    configPath,
    auditLogger,
    approvalStream,
    approvalPreviews,
  });
  const hitlProvider = new CompositeHitlProvider([configuredHitlProvider, approvalStream]);
  const unsubscribeActivityNotifications = activityStream.subscribe((event) => {
    void hitlProvider
      .notifyActivity?.(event)
      .catch((err) => log.error({ err }, 'Failed to send activity notification'));
  });

  const getConfig = () => activeConfig;
  hitlEngine = new HitlEngine(auditLogger, hitlProvider, config.approvals.timeout_ms, {
    grants: createGrantStore(auditLogger, getConfig),
    ...engineOptionsFromConfig(config, getConfig),
  });

  wireBatcher(hitlBatcher, hitlEngine, hitlProvider);

  await hitlProvider.init();
  await hitlEngine.recoverPending();

  // Pool — only the MCPs this profile actually needs
  const mcpConfigs = getMcpConfigs(config.providers);
  const allMcpIds = Object.keys(mcpConfigs);
  const selectMcps = (cfg: Config, agent: Config['agents'][string]) => {
    const all = getMcpConfigs(cfg.providers);
    const ids = Object.keys(all);
    const needed = [
      ...new Set([
        ...requiredMcpsForAgent(agent, ids),
        ...Object.values(cfg.approvals.previews ?? {})
          .map((preview) => preview.tool.split('/')[0])
          .filter((id) => ids.includes(id)),
      ]),
    ];
    return Object.fromEntries(needed.map((id) => [id, all[id]]));
  };
  const filteredMcps = selectMcps(config, agentConfig);
  const neededIds = Object.keys(filteredMcps);

  log.info(
    { agentId, needed: neededIds, skipped: allMcpIds.filter((id) => !neededIds.includes(id)) },
    'Connecting to required MCPs only'
  );

  const pool = new ClientPool(filteredMcps, {
    eventsProviders: eventEnabledProviders({ [agentId]: agentConfig }, Object.keys(filteredMcps)),
    // Writes only while holding the store's writer lock; alongside a running gateway it reads.
    oauthStorage: 'writer',
  });
  await pool.initialize();

  const allowlist = new AllowlistEngine(config.agents);
  const uploadStore = new UploadStore(config.uploads);
  let uploadApp: FastifyInstance | undefined;
  let uploadListenerSync: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  let cleanedUp = false;
  let reloadEpoch = 0;

  const bindStdioUploadListener = async (): Promise<{ app: FastifyInstance; baseUrl: string }> => {
    const app = Fastify({ logger: false });
    // Expose only single-use presigned upload/download routes on the ephemeral loopback listener;
    // direct agent-token routes belong to the authenticated HTTP gateway plane.
    await app.register(uploadsApiPlugin, {
      uploadStore,
      enableDirectRoutes: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const bound = app.server.address();
    const baseUrl =
      typeof bound === 'object' && bound !== null
        ? `http://127.0.0.1:${bound.port}`
        : uploadStore.getPublicBaseUrl();
    return { app, baseUrl };
  };

  const syncStdioUploadListener = (): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!uploadStore.isEnabled() || shuttingDown || cleanedUp) {
        if (uploadApp) {
          const closing = uploadApp;
          uploadApp = undefined;
          await closing.close().catch(() => {});
        }
        return;
      }
      if (uploadApp) return;
      const { app, baseUrl } = await bindStdioUploadListener();
      // Re-check after async listen in case uploads were disabled or shutdown started mid-startup.
      if (!uploadStore.isEnabled() || shuttingDown || cleanedUp) {
        await app.close().catch(() => {});
        return;
      }
      uploadStore.setRuntimeBaseUrl(baseUrl);
      uploadApp = app;
      log.info(
        { url: uploadStore.getPublicBaseUrl() },
        'Airlock stdio ephemeral upload listener ready'
      );
    };
    uploadListenerSync = uploadListenerSync.then(run, run);
    return uploadListenerSync;
  };
  await syncStdioUploadListener();

  const airlockDeps = () => ({
    hitlEngine,
    hitlBatcher,
    activityStream,
    uploadStore,
    getAgentTools: (id: string) => registryRef.current?.getFilteredWithDecisions(id) ?? [],
    getAgentConfig: (id: string) => activeConfig.agents[id],
    getRawToolSchema: (toolName: string, id: string) => {
      const resolved = registryRef.current?.resolveToolName(toolName, id) ?? toolName;
      const tools = registryRef.current?.getAllTools() ?? [];
      return (
        tools.find((t) => t.name === toolName)?.inputSchema ??
        tools.find((t) => t.name === resolved)?.inputSchema
      );
    },
    getToolBackendKind: (toolName: string, id: string) =>
      registryRef.current?.getToolBackendKind(toolName, id),
    nativeUploadArgKind: (toolName: string, topKey: string, id: string) =>
      registryRef.current?.nativeUploadArgKind(toolName, topKey, id),
    getKnownProviderIds: () => knownProviderIds(activeConfig),
    getProviderConnectionStatus: (providerId: string) =>
      providerConnectionStatus(activeConfig, pool, providerId),
  });

  // Build adapters from config (MCP, builtins, CLIs, APIs)
  const adapters = buildAdapters(config, pool, {
    uploadStore,
    airlock: airlockDeps(),
  });

  const registry = new ToolRegistry(
    adapters,
    allowlist,
    config.agents,
    getProviderInstructions(config.providers)
  );
  registryRef.current = registry;

  const eventRegistry = new EventRegistry(pool, allowlist);
  const eventStreamManager = new EventStreamManager((profileId) => {
    const resolved = resolveLimits(
      activeConfig.agents[profileId]?.limits,
      activeConfig.security.limits
    );
    const globalLimits = resolveLimits(undefined, activeConfig.security.limits);
    return {
      maxEventStreamsPerAgent: resolved.maxEventStreamsPerAgent,
      maxEventStreamsGlobal: globalLimits.maxEventStreamsGlobal,
    };
  });
  const eventService = new EventService({
    pool,
    registry: eventRegistry,
    allowlist,
    streamManager: eventStreamManager,
    hitlEngine,
    hitlBatcher,
    auditLogger,
    getAgentConfig: (profileId) => activeConfig.agents[profileId],
  });
  eventRegistry.onRefresh(() => eventService.reconcileAfterReload());

  // Register callback for late-connecting MCPs and dynamic event list changes
  pool.onClientReady((id) => {
    log.info({ id }, 'MCP became ready, refreshing tool and event registries');
    registry
      .refresh()
      .catch((err) => log.error({ err }, 'Failed to refresh registry after MCP ready'));
    eventRegistry
      .refresh()
      .catch((err) => log.error({ err }, 'Failed to refresh event registry after MCP ready'));
  });
  pool.onEventsListChanged((id) => {
    log.info({ id }, 'MCP emitted notifications/events/list_changed, refreshing event registry');
    eventRegistry
      .refresh()
      .catch((err) => log.error({ err }, 'Failed to refresh event registry after list_changed'));
  });

  await registry.refresh();
  await eventRegistry.refresh();

  const managementRequestSecurity: RequestSecurityOptions = {};
  updateManagementRequestSecurity(config, managementRequestSecurity);
  let managementApp: FastifyInstance | undefined;
  if (config.server.management_api?.enabled) {
    managementApp = await startManagementApi({
      config,
      auditLogger,
      hitlEngine,
      activityStream,
      configPath,
      approvalStream,
      approvalPreviews,
      getRequestSecurity: () => managementRequestSecurity,
    });
  }

  const applyReloadedConfig = (
    newConfig: Config,
    myEpoch: number,
    preboundListener?: { app: FastifyInstance; baseUrl: string }
  ): void => {
    // Apply upload store config BEFORE publishing `activeConfig` or allowlists so a failed
    // exclusive directory lock leaves stdio mode on its prior consistent configuration.
    uploadStore.updateConfig(newConfig.uploads);
    if (preboundListener) {
      uploadStore.setRuntimeBaseUrl(preboundListener.baseUrl);
      uploadApp = preboundListener.app;
      log.info(
        { url: uploadStore.getPublicBaseUrl() },
        'Airlock stdio ephemeral upload listener ready'
      );
    }
    if (newConfig.agents[agentId]) {
      currentAgentConfig = newConfig.agents[agentId];
    }
    activeConfig = newConfig;
    hitlEngine.setTimeoutMs(newConfig.approvals.timeout_ms);
    hitlEngine.configure(engineOptionsFromConfig(newConfig, getConfig));
    updateManagementRequestSecurity(newConfig, managementRequestSecurity);
    // Apply allowlist, per-agent upload revocations, and event-stream revocation immediately
    // before waiting on slow provider-pool reconnects.
    allowlist.reload(newConfig.agents);
    uploadStore.reconcileAgents(newConfig.agents);
    if (!newConfig.uploads?.enabled) {
      const closing = uploadApp;
      uploadApp = undefined;
      if (closing) {
        uploadListenerSync = uploadListenerSync.then(
          () => closing.close().catch(() => {}),
          () => closing.close().catch(() => {})
        );
      }
    }
    void eventService
      .reconcileAfterReload()
      .catch((err) => log.error({ err }, 'Failed to reconcile event streams on reload'));
    // Filtered like the initial pool: the unfiltered map would connect every configured provider.
    const newMcpConfigs = selectMcps(newConfig, currentAgentConfig);
    pool
      .reload(
        newMcpConfigs,
        eventEnabledProviders({ [agentId]: currentAgentConfig }, Object.keys(newMcpConfigs))
      )
      .then(async () => {
        if (myEpoch !== reloadEpoch || shuttingDown || cleanedUp) return;
        registry.reloadAgents(newConfig.agents, getProviderInstructions(newConfig.providers));
        const newAdapters = buildAdapters(newConfig, pool, {
          uploadStore,
          airlock: airlockDeps(),
        });
        registry.setAdapters(newAdapters);
        await Promise.all([registry.refresh(), eventRegistry.refresh()]);
        if (myEpoch !== reloadEpoch || shuttingDown || cleanedUp) return;
        log.info('Config reloaded: providers, allowlist, agent config, security');
      })
      .catch((err) => {
        log.error({ err }, 'Failed to apply reloaded config');
      });
  };

  // Hot reload — allowlists, agent config, security (not MCP connections or approval provider)
  const watcher = new ConfigWatcher(configPath);
  watcher.on('reload', (newConfig) => {
    try {
      if (
        activeConfig.uploads?.enabled &&
        newConfig.uploads?.enabled &&
        activeConfig.uploads.dir !== newConfig.uploads.dir
      ) {
        log.error(
          'uploads.dir changed while uploads are enabled; restart Airlock to apply the new staging directory'
        );
        return;
      }
      const myEpoch = ++reloadEpoch;
      // When enabling uploads without an active loopback listener, bind the listener BEFORE
      // enabling the store or publishing `activeConfig`/allowlist so bind failures never leave
      // uploads enabled issuing unusable URLs.
      if (newConfig.uploads?.enabled && !uploadApp) {
        void bindStdioUploadListener()
          .then(async (bound) => {
            if (myEpoch !== reloadEpoch || shuttingDown || cleanedUp) {
              await bound.app.close().catch(() => {});
              return;
            }
            try {
              applyReloadedConfig(newConfig, myEpoch, bound);
            } catch (err) {
              await bound.app.close().catch(() => {});
              log.error({ err }, 'Failed to apply reloaded config');
            }
          })
          .catch((err) => {
            log.error(
              { err },
              'Failed to bind stdio upload listener on reload; keeping previous config'
            );
          });
        return;
      }
      applyReloadedConfig(newConfig, myEpoch);
    } catch (err) {
      log.error({ err }, 'Failed to apply reloaded config');
    }
  });
  watcher.start();

  // Graceful shutdown
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    watcher.stop();
    // Open push event streams and approval streams never go idle; end them before closing.
    await eventStreamManager.closeAll();
    await approvalStream.stop();
    await managementApp?.close().catch(() => {});
    await uploadListenerSync.catch(() => {});
    await uploadApp?.close().catch(() => {});
    uploadApp = undefined;
    await uploadStore.stop();
    await pool.stop();
    await registry.stopAll();
    await hitlProvider.stop();
    unsubscribeActivityNotifications();
    auditLogger.stop();
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down stdio mode');
    // Immediately prevent MCP clients from reconnecting — SIGINT
    // propagates to children, killing them before pool.stop() runs.
    pool.disableReconnect();
    // The MCP SDK's StdioClientTransport.close() escalates:
    //   stdin.end → 2s wait → SIGTERM → 2s wait → SIGKILL
    // Give it enough time before forcing exit, otherwise
    // process.exit() orphans children mid-cleanup. OAuth needs longer still: an
    // in-flight token exchange (up to the 15 s request timeout) must be committed before exit,
    // so the deadline is SHUTDOWN_FORCE_EXIT_MS (the container stop grace period must exceed it).
    const forceExit = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      pool.forceKill();
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExit.unref();
    try {
      await cleanup();
    } catch (err) {
      log.error({ err }, 'Error during stdio shutdown');
    }
    process.exit(0);
  };

  const handleSigterm = () => void shutdown();
  const handleSigint = () => void shutdown();
  process.on('SIGTERM', handleSigterm);
  process.on('SIGINT', handleSigint);

  try {
    await runStdioServer({
      agentId,
      downstreamSessionId,
      agentConfig,
      getAgentConfig: () => currentAgentConfig,
      registry,
      allowlist,
      hitlEngine,
      hitlBatcher,
      hitlProvider,
      auditLogger,
      securityConfig: config.security,
      uploadStore,
      eventService,
    });
  } finally {
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
    if (!shuttingDown) {
      await cleanup();
    }
  }
}

function knownProviderIds(config: Config): string[] {
  const ids = new Set<string>([
    ...Object.keys(getMcpConfigs(config.providers)),
    ...getBuiltinProviders(config.providers),
    ...Object.keys(config.clis ?? {}),
    ...Object.keys(config.apis ?? {}),
  ]);
  return Array.from(ids).sort();
}

function providerConnectionStatus(config: Config, pool: ClientPool, providerId: string) {
  if (!(providerId in getMcpConfigs(config.providers))) return undefined;
  return (
    pool.getProviderConnectionStatus(providerId) ?? {
      status: 'down' as const,
      reason: 'MCP provider is not connected',
    }
  );
}

function updateManagementRequestSecurity(config: Config, target: RequestSecurityOptions): void {
  target.secret = config.server.management_api?.api_secret ?? config.server.api_secret;
  target.authRequired = true;
  target.allowedOrigins = config.server.allowed_origins;
}

async function startManagementApi(opts: {
  config: Config;
  auditLogger: AuditLogger;
  hitlEngine: HitlEngine;
  activityStream: ActivityStream;
  configPath: string;
  approvalStream: ApprovalStreamHub;
  approvalPreviews: ApprovalPreviewReader;
  getRequestSecurity: () => RequestSecurityOptions;
}): Promise<FastifyInstance | undefined> {
  const app = Fastify({ logger: false });
  const {
    auditLogger,
    hitlEngine,
    activityStream,
    configPath,
    approvalStream,
    getRequestSecurity,
  } = opts;

  await app.register(hitlApiPlugin, {
    engine: hitlEngine,
    getRequestSecurity,
  });
  await app.register(auditApiPlugin, {
    auditLogger,
    getRequestSecurity,
  });
  await app.register(mobileApiPlugin, {
    auditLogger,
    engine: hitlEngine,
    activityStream,
    configPath,
    getRequestSecurity,
    approvalStream,
    approvalPreviews: opts.approvalPreviews,
  });
  await app.register((previewApp, _opts, done) => {
    previewApp.addHook('preHandler', (request, reply, hookDone) => {
      if (!checkRequestSecurity(request, reply, getRequestSecurity())) return;
      hookDone();
    });
    new ApprovalDashboardRoutes(
      hitlEngine,
      approvalStream,
      opts.approvalPreviews
    ).registerPreviewRoute(previewApp);
    done();
  });

  app.get('/health', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, getRequestSecurity())) return;
    return {
      status: 'ok',
      pendingApprovals: hitlEngine.pendingCount(),
    };
  });

  const { port, host } = opts.config.server.management_api;
  try {
    await app.listen({ port, host });
  } catch (err) {
    // Every stdio session is its own process, and a gateway sharing this config may already hold
    // the port. Run the session without a management API rather than refusing to start it.
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code !== 'EADDRINUSE') throw err;
    log.warn({ port, host }, 'Management API port in use; running this session without it');
    await app.close().catch(() => {});
    return undefined;
  }
  log.info({ port, host }, 'Airlock stdio management API listening');
  return app;
}
