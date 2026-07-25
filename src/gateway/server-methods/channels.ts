// Gateway RPC handlers for channel lifecycle, status, and account operations.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { redactChannelStatusSummaryBaseUrl } from "../../channels/account-snapshot-fields.js";
import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../channel-health-policy.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { formatForLog } from "../ws-log.js";
import { channelLifecycleHandlers } from "./channels-lifecycle.js";
import type { GatewayRequestHandlers } from "./types.js";

const CHANNEL_STATUS_MAX_TIMEOUT_MS = 30_000;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;

function channelStatusTimeoutPayload(step: string, timeoutMs: number): Record<string, unknown> {
  return {
    ok: false,
    timedOut: true,
    error: `${step} timed out after ${timeoutMs}ms`,
  };
}

type TimeoutRaceResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

async function raceWithTimeout<T>(params: {
  timeoutMs: number;
  run: () => Promise<T> | T;
}): Promise<TimeoutRaceResult<T>> {
  const timeoutMs = params.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
  const result = await Promise.race([
    Promise.resolve()
      .then(params.run)
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    timeout,
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

async function runChannelStatusHook(params: {
  accountId: string;
  channelId: ChannelId;
  step: "audit" | "probe";
  timeoutMs: number;
  warnings: string[];
  run: () => Promise<unknown>;
}): Promise<unknown> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  // Channel probes come from plugin code and external services. Convert slow or
  // failing hooks into partial status data so one channel cannot block the UI.
  const result = await raceWithTimeout({
    timeoutMs,
    run: params.run,
  });
  if (result.kind === "value") {
    return result.value;
  }
  const warningPrefix = `${params.channelId}:${params.accountId} ${params.step}`;
  if (result.kind === "timeout") {
    params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
    return channelStatusTimeoutPayload(params.step, timeoutMs);
  }
  const message = formatForLog(result.error);
  params.warnings.push(`${warningPrefix} failed: ${message}`);
  return {
    ok: false,
    error: message,
  };
}

type Summary = { ok: true; value: unknown } | { ok: false; error: string; timedOut?: boolean };

async function runChannelStatusSummary(params: {
  channelId: ChannelId;
  timeoutMs: number;
  warnings: string[];
  run: () => unknown;
}): Promise<Summary> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const result = await raceWithTimeout({
    timeoutMs,
    run: params.run,
  });
  const warningPrefix = `${params.channelId} summary`;
  if (result.kind === "value") {
    // Summary hooks return the final public record, after account snapshot sanitization.
    return { ok: true, value: redactChannelStatusSummaryBaseUrl(result.value) };
  }
  if (result.kind === "timeout") {
    const error = `summary timed out after ${timeoutMs}ms`;
    params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
    return { ok: false, timedOut: true, error };
  }
  const message = formatForLog(result.error);
  params.warnings.push(`${warningPrefix} failed: ${message}`);
  return { ok: false, error: message };
}

function channelStatusFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== "string" || record.error.length === 0) {
    return null;
  }
  return record.error;
}

function resolveChannelsStatusTimeoutMs(params: { probe: boolean; timeoutMsRaw: unknown }): number {
  const fallback = params.probe ? CHANNEL_STATUS_MAX_TIMEOUT_MS : 10_000;
  if (typeof params.timeoutMsRaw !== "number" || !Number.isFinite(params.timeoutMsRaw)) {
    return fallback;
  }
  return Math.min(Math.max(1000, params.timeoutMsRaw), CHANNEL_STATUS_MAX_TIMEOUT_MS);
}

/** Gateway request handlers for channel list, status, start, stop, and logout. */
export const channelsHandlers: GatewayRequestHandlers = {
  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = resolveChannelsStatusTimeoutMs({ probe, timeoutMsRaw });
    const rawChannel = (params as { channel?: unknown }).channel;
    const requestedChannel =
      typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : undefined;
    const runtimeConfig = context.getRuntimeConfig();
    const cfg = resolveGatewayPluginConfig({
      config: runtimeConfig,
    });
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const selectedPlugins = requestedChannel
      ? plugins.filter((plugin) => plugin.id === requestedChannel)
      : plugins;
    if (rawChannel !== undefined && !requestedChannel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`),
      );
      return;
    }
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      selectedPlugins.map((plugin) => [plugin.id, plugin]),
    );
    const statusWarnings: string[] = [];

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntimeLocal = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntimeLocal : undefined);
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildAccountSnapshot = async (
      channelId: ChannelId,
      plugin: ChannelPlugin,
      accountId: string,
      defaultAccountId: string,
    ) => {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = isAccountEnabled(plugin, account);
      let probeResult: unknown;
      let lastProbeAt: number | null = null;
      if (probe && enabled && plugin.status?.probeAccount) {
        // Skip expensive probes for accounts that are not configured; the
        // snapshot builder still reports the config state below.
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          probeResult = await runChannelStatusHook({
            channelId,
            accountId,
            step: "probe",
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.probeAccount!({
                account,
                timeoutMs,
                cfg,
              }),
          });
          lastProbeAt = Date.now();
        }
      }
      let auditResult: unknown;
      if (probe && enabled && plugin.status?.auditAccount) {
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          auditResult = await runChannelStatusHook({
            channelId,
            accountId,
            step: "audit",
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.auditAccount!({
                account,
                timeoutMs,
                cfg,
                probe: probeResult,
              }),
          });
        }
      }
      const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
      const snapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
        runtime: runtimeSnapshot,
        probe: probeResult,
        audit: auditResult,
      });
      const hookError =
        channelStatusFailureMessage(auditResult) ?? channelStatusFailureMessage(probeResult);
      if (hookError && !snapshot.lastError) {
        snapshot.lastError = hookError;
      }
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
      const activity = getChannelActivity({
        channel: channelId as never,
        accountId,
      });
      if (snapshot.lastInboundAt == null) {
        snapshot.lastInboundAt = activity.inboundAt;
      }
      if (snapshot.lastOutboundAt == null) {
        snapshot.lastOutboundAt = activity.outboundAt;
      }
      const health = evaluateChannelHealth(snapshot, {
        channelId,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      if (!health.healthy) {
        snapshot.healthState = health.reason;
      }
      return { accountId, account, snapshot };
    };

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const resolvedAccounts: Record<string, unknown> = {};
      const { results } = await runTasksWithConcurrency({
        tasks: accountIds.map(
          (accountId) => async () =>
            await buildAccountSnapshot(channelId, plugin, accountId, defaultAccountId),
        ),
        limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : accountIds.length || 1,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      for (const result of results) {
        if (result) {
          resolvedAccounts[result.accountId] = result.account;
          accounts.push(result.snapshot);
        }
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(selectedPlugins);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      ...(context.getEventLoopHealth ? { eventLoop: context.getEventLoopHealth() } : {}),
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    const { results: channelResults } = await runTasksWithConcurrency({
      tasks: selectedPlugins.map((plugin) => async () => {
        const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
          await buildChannelAccounts(plugin.id);
        const fallbackAccount =
          resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
        const fallbackSummary = (lastError?: string) => ({
          configured: defaultAccount?.configured ?? false,
          ...(lastError ? { lastError } : {}),
        });
        let summary: unknown = fallbackSummary();
        if (plugin.status?.buildChannelSummary) {
          const summaryResult = await runChannelStatusSummary({
            channelId: plugin.id,
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.buildChannelSummary!({
                account: fallbackAccount,
                cfg,
                defaultAccountId,
                snapshot:
                  defaultAccount ??
                  ({
                    accountId: defaultAccountId,
                  } as ChannelAccountSnapshot),
              }),
          });
          summary = summaryResult.ok ? summaryResult.value : fallbackSummary(summaryResult.error);
        }
        return { pluginId: plugin.id, summary, accounts, defaultAccountId };
      }),
      limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : selectedPlugins.length || 1,
    });
    for (const result of channelResults) {
      if (result) {
        channelsMap[result.pluginId] = result.summary;
        accountsMap[result.pluginId] = result.accounts;
        defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
      }
    }
    if (statusWarnings.length > 0) {
      payload.partial = true;
      payload.warnings = statusWarnings.slice(0, 50);
    }

    respond(true, payload, undefined);
  },
  ...channelLifecycleHandlers,
};
