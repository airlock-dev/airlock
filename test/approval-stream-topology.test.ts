import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { createServer } from 'net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Gateway } from '../src/gateway.js';
import { GatewayConfig, type AgentConfig } from '../src/config/schema.js';
import type { HitlEngine, HitlTicket } from '../src/hitl/engine.js';
import type { HitlProvider } from '../src/hitl/providers/types.js';
import type { ApprovalStreamHub } from '../src/hitl/approval-stream.js';
import type { ActivityStream } from '../src/activity/stream.js';
import type { AgentServerDeps } from '../src/transport/agent-server.js';

type ProviderName = 'dashboard' | 'ios';
type EntryPoint = 'gateway' | 'stdio';
type ResolutionSource = 'dashboard' | 'mobile' | 'ios' | 'timeout';

interface StartTopologyParams {
  entryPoint: EntryPoint;
  managementApi: boolean;
  providers: ProviderName[];
  timeoutMs?: number;
  exposeHookApi?: boolean;
  agent?: Partial<AgentConfig>;
}

interface StreamEndpoint {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

interface RunningTopology {
  engine: HitlEngine;
  provider: HitlProvider;
  consumers: StreamEndpoint[];
  managementBaseUrl?: string;
  dashboardBaseUrl?: string;
  approvalStream?: ApprovalStreamHub;
  emitActivity(): Promise<void>;
  stop(): Promise<void>;
}

interface StreamClient {
  name: string;
  messages: Array<Record<string, unknown>>;
  waitForType(type: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const ADMIN_HEADERS = { authorization: 'Bearer admin-secret' };

describe('approval stream topology matrix', () => {
  const tempDirs: string[] = [];
  const topologies: RunningTopology[] = [];
  const clients: StreamClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(topologies.splice(0).map((topology) => topology.stop()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  const topologyCases: Array<{
    name: string;
    entryPoint: EntryPoint;
    managementApi: boolean;
    providers: ProviderName[];
    expectedConsumers: string[];
  }> = [
    {
      name: 'gateway mgmt on with dashboard and ios providers',
      entryPoint: 'gateway',
      managementApi: true,
      providers: ['dashboard', 'ios'],
      expectedConsumers: ['dashboard', 'mobile'],
    },
    {
      name: 'gateway mgmt on with ios provider only',
      entryPoint: 'gateway',
      managementApi: true,
      providers: ['ios'],
      expectedConsumers: ['mobile'],
    },
    {
      name: 'gateway mgmt on with no display providers',
      entryPoint: 'gateway',
      managementApi: true,
      providers: [],
      expectedConsumers: ['mobile'],
    },
    {
      name: 'gateway mgmt off with dashboard provider',
      entryPoint: 'gateway',
      managementApi: false,
      providers: ['dashboard'],
      expectedConsumers: ['dashboard'],
    },
    {
      name: 'stdio mgmt on with ios provider',
      entryPoint: 'stdio',
      managementApi: true,
      providers: ['ios'],
      expectedConsumers: ['mobile'],
    },
    {
      name: 'gateway mgmt off with no providers and no consumers',
      entryPoint: 'gateway',
      managementApi: false,
      providers: [],
      expectedConsumers: [],
    },
  ];

  it.each(topologyCases)('$name', async (testCase) => {
    const topology = await startTopology(testCase);
    topologies.push(topology);
    expect(topology.consumers.map((consumer) => consumer.name).sort()).toEqual(
      [...testCase.expectedConsumers].sort()
    );

    const ticket = await createAndNotify(topology, { timeoutMs: topology.engine.timeoutMs });
    const connectedClients = await connectAll(topology.consumers);
    clients.push(...connectedClients);

    await assertLifecycleExactlyOnce({
      topology,
      clients: connectedClients,
      ticket,
      resolve: async () => {
        topology.engine.approve(ticket.id);
        await ticket.result;
      },
      expectedResult: 'approved',
    });

    if (topology.approvalStream) {
      expect(topology.approvalStream.pendingCount()).toBe(0);
    }
  });

  const resolutionCases: Array<{
    source: ResolutionSource;
    timeoutMs?: number;
    expectedResult: 'approved' | 'timeout';
  }> = [
    { source: 'dashboard', expectedResult: 'approved' },
    { source: 'mobile', expectedResult: 'approved' },
    { source: 'ios', expectedResult: 'approved' },
    { source: 'timeout', timeoutMs: 250, expectedResult: 'timeout' },
  ];

  it.each(resolutionCases)(
    'delivers one resolved event per client when resolved by $source',
    async ({ source, timeoutMs = 300000, expectedResult }) => {
      const topology = await startTopology({
        name: `resolution via ${source}`,
        entryPoint: 'gateway',
        managementApi: true,
        providers: ['dashboard'],
        expectedConsumers: ['dashboard', 'mobile'],
        timeoutMs,
      });
      topologies.push(topology);

      const ticket = await createAndNotify(topology, { timeoutMs });
      const connectedClients = await connectAll(topology.consumers);
      clients.push(...connectedClients);

      await assertLifecycleExactlyOnce({
        topology,
        clients: connectedClients,
        ticket,
        resolve: () => resolveApproval(topology, ticket, source),
        expectedResult,
      });
    }
  );

  it('streams and resolves an approval created through the real gateway hook route', async () => {
    const topology = await startTopology({
      entryPoint: 'gateway',
      managementApi: true,
      providers: ['dashboard'],
      exposeHookApi: true,
      agent: { ask: ['bash/*'] },
    });
    topologies.push(topology);
    expect(topology.consumers.map((consumer) => consumer.name).sort()).toEqual([
      'dashboard',
      'mobile',
    ]);

    const connectedClients = await connectAll(topology.consumers);
    clients.push(...connectedClients);

    const hookResponsePromise = postHookRequest(topology, {
      client: 'claude-code',
      agent: 'test',
      tool: 'Bash',
      input: { command: 'git status' },
    });

    await Promise.all(connectedClients.map((client) => client.waitForType('new')));
    await topology.emitActivity();
    await Promise.all(connectedClients.map((client) => client.waitForType('activity')));

    const pending = topology.engine.getPending()[0];
    expect(pending).toMatchObject({
      agentId: 'test',
      tool: 'bash/git',
    });

    if (!topology.dashboardBaseUrl) throw new Error('Dashboard URL is not available');
    const approveResponse = await fetch(
      `${topology.dashboardBaseUrl}/approve?code=${pending.code}`,
      { method: 'POST' }
    );
    expect(approveResponse.status).toBe(200);

    const hookResponse = await hookResponsePromise;
    expect(hookResponse.status).toBe(200);
    await expect(hookResponse.json()).resolves.toEqual({
      decision: 'allow',
      tool: 'bash/git',
    });

    await Promise.all(connectedClients.map((client) => client.waitForType('resolved')));
    await delay(50);

    for (const client of connectedClients) {
      expect(countMessages(client, 'new'), `${client.name} new count`).toBe(1);
      expect(countMessages(client, 'activity'), `${client.name} activity count`).toBe(1);
      expect(countMessages(client, 'resolved'), `${client.name} resolved count`).toBe(1);
      expect(client.messages.find((message) => message.type === 'new')).toMatchObject({
        request: { id: pending.id, code: pending.code, tool: 'bash/git' },
      });
      expect(client.messages.find((message) => message.type === 'resolved')).toMatchObject({
        id: pending.id,
        code: pending.code,
        result: 'approved',
      });
    }
  });

  async function startTopology(params: StartTopologyParams): Promise<RunningTopology> {
    if (params.entryPoint === 'stdio') {
      return startStdioTopology(params);
    }
    return startGatewayTopology(params);
  }

  async function startGatewayTopology(params: {
    managementApi: boolean;
    providers: ProviderName[];
    timeoutMs?: number;
    exposeHookApi?: boolean;
    agent?: Partial<AgentConfig>;
  }): Promise<RunningTopology> {
    const dir = makeTempDir('airlock-stream-gateway-');
    const configPath = writeGatewayConfigFile(dir);
    const config = GatewayConfig.parse({
      agents: {
        test: {
          token: 'agent-secret',
          ...params.agent,
        },
      },
      approvals: {
        provider: providerConfigs(params.providers, dir),
        timeout_ms: params.timeoutMs ?? 300000,
        batch_window_ms: 0,
      },
      server: {
        port: 1,
        host: '127.0.0.1',
        api_secret: 'data-secret',
        auth_required: true,
        management_api: {
          enabled: params.managementApi,
          expose_hook_api: params.exposeHookApi ?? false,
          api_secret: 'admin-secret',
          port: 1,
          host: '127.0.0.1',
        },
      },
      audit: {
        db_path: join(dir, 'audit.db'),
      },
    });
    config.server.port = 0;
    if (params.managementApi) config.server.management_api.port = 0;
    for (const provider of approvalProviderList(config.approvals.provider)) {
      if (provider.type === 'dashboard') provider.port = 0;
    }

    const gateway = new Gateway(config, configPath);
    await gateway.start();

    const consumers: StreamEndpoint[] = [];
    const managementApp = (gateway as unknown as { managementApp?: FastifyInstance }).managementApp;
    const managementBaseUrl = managementApp ? baseUrl(managementApp) : undefined;
    if (managementBaseUrl) {
      consumers.push({
        name: 'mobile',
        url: `${managementBaseUrl}/mobile/approvals/stream`,
        headers: ADMIN_HEADERS,
      });
    }

    const dashboardApp = findDashboardApp(
      (gateway as unknown as { hitlProvider: HitlProvider }).hitlProvider
    );
    const dashboardBaseUrl = dashboardApp ? baseUrl(dashboardApp) : undefined;
    if (dashboardBaseUrl) {
      consumers.push({ name: 'dashboard', url: `${dashboardBaseUrl}/events` });
    }

    const provider = (gateway as unknown as { hitlProvider: HitlProvider }).hitlProvider;
    const activityStream = (gateway as unknown as { activityStream: ActivityStream })
      .activityStream;
    return {
      engine: (gateway as unknown as { hitlEngine: HitlEngine }).hitlEngine,
      provider,
      consumers,
      managementBaseUrl,
      dashboardBaseUrl,
      approvalStream: (gateway as unknown as { approvalStream: ApprovalStreamHub }).approvalStream,
      emitActivity: async () => {
        activityStream.emit(activityEventParams());
      },
      stop: () => gateway.stop(),
    };
  }

  async function startStdioTopology(params: {
    managementApi: boolean;
    providers: ProviderName[];
    timeoutMs?: number;
    agent?: Partial<AgentConfig>;
  }): Promise<RunningTopology> {
    const dir = makeTempDir('airlock-stream-stdio-');
    const configPath = writeGatewayConfigFile(dir);
    const managementPort = await getAvailablePort();
    const config = GatewayConfig.parse({
      agents: {
        test: {
          token: 'agent-secret',
          ...params.agent,
        },
      },
      approvals: {
        provider: providerConfigs(params.providers, dir),
        timeout_ms: params.timeoutMs ?? 300000,
        batch_window_ms: 0,
      },
      server: {
        port: 4111,
        host: '127.0.0.1',
        api_secret: 'data-secret',
        auth_required: true,
        management_api: {
          enabled: params.managementApi,
          api_secret: 'admin-secret',
          port: managementPort,
          host: '127.0.0.1',
        },
      },
      audit: {
        db_path: join(dir, 'audit.db'),
      },
    });

    const stdioServerModule = await import('../src/transport/stdio-server.js');
    const { runStdioMode } = await import('../src/stdio-mode.js');
    let capturedDeps: AgentServerDeps | undefined;
    let resolveStdioServer!: () => void;
    const stdioServerDone = new Promise<void>((resolve) => {
      resolveStdioServer = resolve;
    });
    vi.spyOn(stdioServerModule, 'runStdioServer').mockImplementation(async (deps) => {
      capturedDeps = deps;
      await stdioServerDone;
    });

    const runPromise = runStdioMode(config, 'test', configPath);
    await waitFor(() => capturedDeps !== undefined);
    const deps = capturedDeps;
    if (!deps) throw new Error('Stdio server deps were not captured');

    return {
      engine: deps.hitlEngine,
      provider: deps.hitlProvider,
      consumers: params.managementApi
        ? [
            {
              name: 'mobile',
              url: `http://127.0.0.1:${managementPort}/mobile/approvals/stream`,
              headers: ADMIN_HEADERS,
            },
          ]
        : [],
      managementBaseUrl: params.managementApi ? `http://127.0.0.1:${managementPort}` : undefined,
      emitActivity: async () => {
        await deps.hitlProvider.notifyActivity?.(activityEvent());
      },
      stop: async () => {
        resolveStdioServer();
        await runPromise;
      },
    };
  }

  async function assertLifecycleExactlyOnce(params: {
    topology: RunningTopology;
    clients: StreamClient[];
    ticket: HitlTicket;
    resolve: () => Promise<void>;
    expectedResult: 'approved' | 'timeout';
  }): Promise<void> {
    const { topology, clients: connectedClients, ticket, expectedResult } = params;
    await Promise.all(connectedClients.map((client) => client.waitForType('new')));
    await topology.emitActivity();
    await Promise.all(connectedClients.map((client) => client.waitForType('activity')));
    await params.resolve();
    await expect(ticket.result).resolves.toBe(expectedResult);
    await Promise.all(connectedClients.map((client) => client.waitForType('resolved')));
    await delay(50);

    for (const client of connectedClients) {
      expect(countMessages(client, 'new'), `${client.name} new count`).toBe(1);
      expect(countMessages(client, 'activity'), `${client.name} activity count`).toBe(1);
      expect(countMessages(client, 'resolved'), `${client.name} resolved count`).toBe(1);
      expect(client.messages.find((message) => message.type === 'new')).toMatchObject({
        request: { id: ticket.id, code: ticket.code },
      });
      expect(client.messages.find((message) => message.type === 'resolved')).toMatchObject({
        id: ticket.id,
        code: ticket.code,
        result: expectedResult,
      });
    }
  }

  async function resolveApproval(
    topology: RunningTopology,
    ticket: HitlTicket,
    source: ResolutionSource
  ): Promise<void> {
    if (source === 'dashboard') {
      if (!topology.dashboardBaseUrl) throw new Error('Dashboard URL is not available');
      const response = await fetch(`${topology.dashboardBaseUrl}/approve?code=${ticket.code}`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      return;
    }

    if (source === 'mobile') {
      await postMobileDecision(topology, ticket, ADMIN_HEADERS);
      return;
    }

    if (source === 'ios') {
      const token = await registerIosDevice(topology);
      await postMobileDecision(topology, ticket, { authorization: `Bearer ${token}` });
      return;
    }

    await ticket.result;
  }

  async function registerIosDevice(topology: RunningTopology): Promise<string> {
    if (!topology.managementBaseUrl) throw new Error('Management URL is not available');
    const response = await fetch(`${topology.managementBaseUrl}/mobile/devices/register`, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Topology iPhone',
        platform: 'ios',
        pushToken: 'test-apns-token',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    return body.token;
  }

  async function postMobileDecision(
    topology: RunningTopology,
    ticket: HitlTicket,
    headers: Record<string, string>
  ): Promise<void> {
    if (!topology.managementBaseUrl) throw new Error('Management URL is not available');
    const response = await fetch(
      `${topology.managementBaseUrl}/mobile/approvals/${ticket.id}/decision`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved' }),
      }
    );
    expect(response.status).toBe(200);
  }

  function postHookRequest(
    topology: RunningTopology,
    body: Record<string, unknown>
  ): Promise<Response> {
    if (!topology.managementBaseUrl) throw new Error('Management URL is not available');
    return fetch(`${topology.managementBaseUrl}/hook`, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function createAndNotify(
    topology: RunningTopology,
    options: { timeoutMs: number }
  ): Promise<HitlTicket> {
    const ticket = topology.engine.create({
      agentId: 'test',
      tool: 'exec/run',
      args: { command: 'pwd' },
    });
    const pending = topology.engine.getPending().find((entry) => entry.id === ticket.id);
    if (!pending) throw new Error('Expected pending approval');
    await topology.provider.notify([
      {
        ...pending,
        timeoutMs: options.timeoutMs,
        badgeCount: topology.engine.getPending().length,
      },
    ]);
    return ticket;
  }

  async function connectAll(consumers: StreamEndpoint[]): Promise<StreamClient[]> {
    return Promise.all(consumers.map((consumer) => connectStream(consumer)));
  }

  async function connectStream(endpoint: StreamEndpoint): Promise<StreamClient> {
    const controller = new AbortController();
    const response = await fetch(endpoint.url, {
      headers: endpoint.headers,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error(`Stream response for ${endpoint.name} had no body`);

    const reader = response.body.getReader();
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      type: string;
      resolve: (message: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }> = [];

    const readLoop = (async () => {
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          if (!chunk.startsWith('data: ')) continue;

          const message = JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>;
          messages.push(message);
          for (const waiter of [...waiters]) {
            if (waiter.type !== message.type) continue;
            clearTimeout(waiter.timeout);
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    })().catch((err: unknown) => {
      if ((err as { name?: string }).name === 'AbortError') return;
      const error = err instanceof Error ? err : new Error(String(err));
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    });

    return {
      name: endpoint.name,
      messages,
      waitForType: (type: string) => {
        const existing = messages.find((message) => message.type === type);
        if (existing) return Promise.resolve(existing);
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const timeout = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for ${endpoint.name} ${type} event`));
          }, 3000);
          waiters.push({ type, resolve, reject, timeout });
        });
      },
      close: async () => {
        controller.abort();
        await reader.cancel().catch(() => {});
        await readLoop.catch(() => {});
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error('Stream closed'));
        }
      },
    };
  }

  function providerConfigs(providers: ProviderName[], dir: string) {
    return providers.map((provider) => {
      if (provider === 'dashboard') {
        return { type: 'dashboard' as const, host: '127.0.0.1', port: 1 };
      }
      return {
        type: 'ios' as const,
        team_id: 'TEAMID1234',
        key_id: 'KEYID1234',
        key_path: writeFakeApnsKey(dir),
        bundle_id: 'com.airlock.test',
        production: false,
      };
    });
  }

  function writeFakeApnsKey(dir: string): string {
    const keyPath = join(dir, 'AuthKey_TEST.p8');
    writeFileSync(keyPath, 'not-a-real-apns-key\n');
    return keyPath;
  }

  function writeGatewayConfigFile(dir: string): string {
    const configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      [
        'providers:',
        '  exec: builtin',
        'agents:',
        '  test:',
        '    token: agent-secret',
        '    allow: []',
        'approvals:',
        '  provider: []',
        '',
      ].join('\n')
    );
    return configPath;
  }

  function approvalProviderList(
    provider: ReturnType<typeof GatewayConfig.parse>['approvals']['provider']
  ) {
    return Array.isArray(provider) ? provider : [provider];
  }

  function findDashboardApp(provider: unknown): FastifyInstance | undefined {
    if (provider && typeof provider === 'object' && 'app' in provider) {
      const app = (provider as { app?: FastifyInstance }).app;
      if (app) return app;
    }
    const children =
      provider && typeof provider === 'object' && 'providers' in provider
        ? (provider as { providers?: unknown[] }).providers
        : undefined;
    for (const child of children ?? []) {
      const app = findDashboardApp(child);
      if (app) return app;
    }
    return undefined;
  }

  function baseUrl(app: FastifyInstance): string {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  }

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function activityEventParams() {
    return {
      kind: 'notification' as const,
      agentId: 'test',
      title: 'Topology activity',
      body: 'Approval stream activity event',
      severity: 'success' as const,
    };
  }

  function activityEvent() {
    return {
      id: 'activity-1',
      ...activityEventParams(),
      createdAt: new Date().toISOString(),
    };
  }

  function countMessages(client: StreamClient, type: string): number {
    return client.messages.filter((message) => message.type === type).length;
  }

  async function getAvailablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    return port;
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
      await delay(10);
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});
