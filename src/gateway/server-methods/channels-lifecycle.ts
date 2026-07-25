import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChannelsLogoutParams,
  validateChannelsStartParams,
  validateChannelsStopParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  type ChannelId,
  getChannelPlugin,
  getLoadedChannelPluginCandidateFingerprint,
  getLoadedChannelPluginOrigin,
  getLoadedChannelPluginOwnerId,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

type ChannelStartPayload = {
  channel: ChannelId;
  accountId: string;
  started: boolean;
};

type ChannelStopPayload = {
  channel: ChannelId;
  accountId: string;
  stopped: boolean;
};

type ChannelOperationParams = {
  channel?: unknown;
  accountId?: unknown;
  exactChannel?: unknown;
  pluginId?: unknown;
  pluginOrigin?: unknown;
  pluginCandidateFingerprint?: unknown;
};

function resolveChannelOperationParams<TParams extends ChannelOperationParams>(params: {
  method: string;
  rawParams: unknown;
  respond: RespondFn;
  validate: Validator<TParams>;
}): {
  params: TParams;
  rawChannel: unknown;
  channelId: ChannelId;
  exactChannel: boolean;
} | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return null;
  }
  const rawChannel = rawParams.channel;
  const exactChannel = rawParams.exactChannel === true;
  const channelId =
    typeof rawChannel === "string"
      ? exactChannel
        ? (normalizeOptionalString(rawChannel) as ChannelId | undefined)
        : normalizeChannelId(rawChannel)
      : null;
  if (!channelId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} channel`),
    );
    return null;
  }
  return { params: rawParams, rawChannel, channelId, exactChannel };
}

function hasChannelPluginOwnerMismatch(params: {
  channelId: ChannelId;
  plugin: ChannelPlugin;
  requestedPluginId: unknown;
  requestedPluginOrigin: unknown;
  requestedPluginCandidateFingerprint: unknown;
}): boolean {
  const requestedPluginId = normalizeOptionalString(params.requestedPluginId);
  const requestedPluginOrigin = normalizeOptionalString(params.requestedPluginOrigin);
  const requestedPluginCandidateFingerprint = normalizeOptionalString(
    params.requestedPluginCandidateFingerprint,
  );
  const loadedOwnerId = getLoadedChannelPluginOwnerId(params.channelId);
  const loadedPluginId = loadedOwnerId ?? params.plugin.id;
  const loadedPluginOrigin =
    getLoadedChannelPluginOrigin(params.channelId) ?? (loadedOwnerId ? undefined : "bundled");
  const loadedPluginCandidateFingerprint = getLoadedChannelPluginCandidateFingerprint(
    params.channelId,
  );
  return (
    (requestedPluginId !== undefined && loadedPluginId !== requestedPluginId) ||
    (requestedPluginOrigin !== undefined && loadedPluginOrigin !== requestedPluginOrigin) ||
    (requestedPluginCandidateFingerprint !== undefined &&
      loadedPluginCandidateFingerprint !== requestedPluginCandidateFingerprint)
  );
}

function resolveRuntimeAccountSnapshot(params: {
  runtime: ChannelRuntimeSnapshot;
  channelId: ChannelId;
  accountId: string;
}) {
  const accounts = params.runtime.channelAccounts[params.channelId];
  const direct = accounts?.[params.accountId];
  if (direct) {
    return direct;
  }
  const fallback = params.runtime.channels[params.channelId];
  return fallback?.accountId === params.accountId ? fallback : undefined;
}

function resolveChannelGatewayAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  // Runtime operations use the same account precedence as channel setup:
  // explicit request, plugin default, first configured account, then fallback.
  return (
    normalizeOptionalString(params.accountId) ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}

async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  // Stop the runtime before clearing channel-owned auth so no active watcher can
  // immediately reconnect with credentials the user is trying to remove.
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = result.cleared;
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

async function startChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelStartPayload> {
  if (!params.plugin.gateway?.startAccount) {
    throw new Error(`Channel ${params.channelId} does not support runtime start`);
  }
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  await params.context.startChannel(params.channelId, resolvedAccountId, { manual: true });
  const runtime = params.context.getRuntimeSnapshot();
  const started =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running === true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    started,
  };
}

async function stopChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelStopPayload> {
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const runtime = params.context.getRuntimeSnapshot();
  const stopped =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running !== true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    stopped,
  };
}

async function respondWithChannelOperationPayload<TPayload>(params: {
  respond: RespondFn;
  run: () => Promise<TPayload>;
}): Promise<void> {
  try {
    params.respond(true, await params.run(), undefined);
  } catch (error) {
    params.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
  }
}

export const channelLifecycleHandlers: GatewayRequestHandlers = {
  "channels.start": async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method: "channels.start",
      rawParams: params,
      respond,
      validate: validateChannelsStartParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, rawChannel, channelId, exactChannel } = resolved;
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          exactChannel
            ? "invalid channels.start channel"
            : `unknown channel: ${formatForLog(rawChannel)}`,
        ),
      );
      return;
    }
    if (
      hasChannelPluginOwnerMismatch({
        channelId,
        plugin,
        requestedPluginId: parsedParams.pluginId,
        requestedPluginOrigin: parsedParams.pluginOrigin,
        requestedPluginCandidateFingerprint: parsedParams.pluginCandidateFingerprint,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.start plugin owner"),
      );
      return;
    }
    if (!plugin.gateway?.startAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support start`),
      );
      return;
    }
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        startChannelAccount({
          channelId,
          accountId: parsedParams.accountId,
          cfg: resolveGatewayPluginConfig({
            config: context.getRuntimeConfig(),
          }),
          context,
          plugin,
        }),
    });
  },
  "channels.stop": async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method: "channels.stop",
      rawParams: params,
      respond,
      validate: validateChannelsStopParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, channelId, exactChannel } = resolved;
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          exactChannel ? "invalid channels.stop channel" : `unknown channel ${channelId}`,
        ),
      );
      return;
    }
    if (
      hasChannelPluginOwnerMismatch({
        channelId,
        plugin,
        requestedPluginId: parsedParams.pluginId,
        requestedPluginOrigin: parsedParams.pluginOrigin,
        requestedPluginCandidateFingerprint: parsedParams.pluginCandidateFingerprint,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.stop plugin owner"),
      );
      return;
    }
    const accountId = normalizeOptionalString(parsedParams.accountId);
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        stopChannelAccount({
          channelId,
          accountId,
          cfg: resolveGatewayPluginConfig({
            config: context.getRuntimeConfig(),
          }),
          context,
          plugin,
        }),
    });
  },
  "channels.logout": async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method: "channels.logout",
      rawParams: params,
      respond,
      validate: validateChannelsLogoutParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, channelId, exactChannel } = resolved;
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          exactChannel && !plugin
            ? "invalid channels.logout channel"
            : `channel ${channelId} does not support logout`,
        ),
      );
      return;
    }
    if (
      hasChannelPluginOwnerMismatch({
        channelId,
        plugin,
        requestedPluginId: parsedParams.pluginId,
        requestedPluginOrigin: parsedParams.pluginOrigin,
        requestedPluginCandidateFingerprint: parsedParams.pluginCandidateFingerprint,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout plugin owner"),
      );
      return;
    }
    const accountId = normalizeOptionalString(parsedParams.accountId);
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        logoutChannelAccount({
          channelId,
          accountId,
          cfg: resolveGatewayPluginConfig({
            config: context.getRuntimeConfig(),
          }),
          context,
          plugin,
        }),
    });
  },
};
