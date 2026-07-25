// Implements guided and non-interactive disable/delete for channel accounts.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import { replaceConfigFile, type OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  isChannelLifecycleGatewayTargetLocal,
  isChannelLifecycleOwnershipUnsupportedByGateway,
  isChannelLifecyclePluginOwnerMismatch,
} from "../../gateway/channel-lifecycle-request.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { channelLabel } from "./runtime-label.js";
import { type ChatChannel, requireValidConfigFileSnapshot, shouldUseWizard } from "./shared.js";

export type ChannelsRemoveOptions = {
  channel?: string;
  account?: string;
  delete?: boolean;
};

function listAccountIds(
  cfg: OpenClawConfig,
  channel: ChatChannel,
  pluginInput?: ChannelPlugin,
): string[] {
  let plugin = pluginInput;
  plugin ??= getChannelPlugin(channel);
  if (!plugin) {
    return [];
  }
  return plugin.config.listAccountIds(cfg);
}

async function stopGatewayRuntimeBeforeRemove(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  pluginId: string;
  pluginOrigin?: string;
  pluginCandidateFingerprint?: string;
  accountId: string;
  plugin: ChannelPlugin;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  if (!params.plugin.gateway?.startAccount && !params.plugin.gateway?.logoutAccount) {
    return true;
  }
  const targetIsLocal = isChannelLifecycleGatewayTargetLocal(params.cfg);
  try {
    await callGateway({
      config: params.cfg,
      method: "channels.stop",
      params: {
        channel: params.channel,
        accountId: params.accountId,
        // The Gateway owns the authoritative alias registry and may have a
        // different plugin snapshot, so every resolved canonical id is exact.
        exactChannel: true,
        pluginId: params.pluginId,
        ...(targetIsLocal && params.pluginOrigin ? { pluginOrigin: params.pluginOrigin } : {}),
        // Candidate fingerprints include host-local source metadata. Remote
        // Gateways cannot compare those paths with the CLI host.
        ...(targetIsLocal && params.pluginCandidateFingerprint
          ? { pluginCandidateFingerprint: params.pluginCandidateFingerprint }
          : {}),
      },
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      deviceIdentity: null,
    });
    return true;
  } catch (error) {
    if (
      isChannelLifecycleOwnershipUnsupportedByGateway(error, "channels.stop") ||
      isChannelLifecyclePluginOwnerMismatch(error, "channels.stop")
    ) {
      if (!targetIsLocal) {
        params.runtime.error(
          `Remote Gateway could not verify channel plugin ownership for ${channelLabel(params.channel)}; restart or upgrade it before retrying removal.`,
        );
        params.runtime.exit(1);
        return false;
      }
      try {
        await callGateway({
          config: params.cfg,
          method: "gateway.restart.request",
          params: { reason: `channel remove: load ${params.channel}` },
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          deviceIdentity: null,
        });
        params.runtime.error(
          `Gateway restart requested; retry removing ${channelLabel(params.channel)} after it restarts.`,
        );
      } catch {
        params.runtime.error(
          `The running Gateway must be restarted before removing ${channelLabel(params.channel)} safely: ${formatErrorMessage(error)}`,
        );
      }
      params.runtime.exit(1);
      return false;
    }
    params.runtime.log(
      `Could not stop running ${channelLabel(params.channel)} account "${params.accountId}" before removing it: ${formatErrorMessage(error)}`,
    );
    return true;
  }
}

/** Disable or delete a channel account, stopping gateway runtime state before mutation. */
export async function channelsRemoveCommand(
  opts: ChannelsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const baseHash = configSnapshot.hash;
  let cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;

  const useWizard = shouldUseWizard(params);
  const prompter = useWizard ? createClackPrompter() : null;
  const rawChannel = normalizeOptionalString(opts.channel) ?? "";
  let lookupChannel = rawChannel;
  let channel: ChatChannel | null = normalizeChannelId(rawChannel);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("Remove channel account");
    const readOnlyPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: true,
    });
    const selectedChannel = await prompter.select({
      message: "Channel",
      options: readOnlyPlugins.map((plugin) => ({
        value: plugin.id,
        label: plugin.meta.label,
      })),
    });
    channel = selectedChannel;
    lookupChannel = selectedChannel;

    accountId = await (async () => {
      const readOnlyPlugin = readOnlyPlugins.find((plugin) => plugin.id === selectedChannel);
      const ids = listAccountIds(cfg, selectedChannel, readOnlyPlugin);
      const choice = await prompter.select({
        message: "Account",
        options: ids.map((id) => ({
          value: id,
          label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
        })),
        initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
      });
      return normalizeAccountId(choice);
    })();
  } else if (!rawChannel) {
    runtime.error(
      `Missing channel. Use ${formatCliCommand("openclaw channels remove --channel <name>")} or run ${formatCliCommand("openclaw channels status")} to inspect configured channels.`,
    );
    runtime.exit(1);
    return;
  }

  const shouldResolveInstallablePlugin = Boolean(lookupChannel || channel);
  const resolvedPluginState = shouldResolveInstallablePlugin
    ? await (async () => {
        const { resolveInstallableChannelPlugin } =
          await import("../channel-setup/channel-plugin-resolution.js");
        return await resolveInstallableChannelPlugin({
          cfg,
          runtime,
          rawChannel: lookupChannel,
          allowInstall: false,
        });
      })()
    : null;
  if (resolvedPluginState?.configChanged) {
    cfg = resolvedPluginState.cfg;
  }
  const resolvedChannel = resolvedPluginState?.channelId ?? channel;
  if (!resolvedChannel) {
    runtime.error(formatUnknownChannelMessage({ channel: rawChannel }));
    runtime.exit(1);
    return;
  }
  channel = resolvedChannel;
  const plugin = resolvedPluginState?.plugin ?? getChannelPlugin(resolvedChannel);
  if (!plugin) {
    if (resolvedPluginState?.catalogEntry) {
      runtime.error(
        `Channel plugin "${resolvedPluginState.catalogEntry.id}" is not installed. Run ${formatCliCommand(`openclaw channels add --channel ${resolvedPluginState.catalogEntry.id}`)} first.`,
      );
      runtime.exit(1);
      return;
    }
    runtime.error(formatUnknownChannelMessage({ channel: resolvedChannel }));
    runtime.exit(1);
    return;
  }
  const resolvedChannelId: ChatChannel = resolvedChannel;
  const resolvedAccountId =
    normalizeAccountId(accountId) ?? resolveChannelDefaultAccountId({ plugin, cfg });
  const accountKey = resolvedAccountId || DEFAULT_ACCOUNT_ID;
  if (useWizard || !deleteConfig) {
    const confirm = prompter ?? createClackPrompter();
    const action = deleteConfig ? "Delete" : "Disable";
    const detail = deleteConfig ? "removes config" : "keeps config";
    const confirmed = await confirm.confirm({
      message: `${action} ${plugin.meta.label ?? channelLabel(resolvedChannelId)} account "${accountKey}"? (${detail})`,
      initialValue: true,
    });
    if (!confirmed) {
      if (prompter) {
        await prompter.outro("Cancelled.");
      }
      return;
    }
  }

  if (
    !(await stopGatewayRuntimeBeforeRemove({
      cfg,
      channel: resolvedChannelId,
      pluginId: resolvedPluginState?.pluginId ?? plugin.id,
      ...(resolvedPluginState?.pluginOrigin
        ? { pluginOrigin: resolvedPluginState.pluginOrigin }
        : {}),
      ...(resolvedPluginState?.pluginCandidateFingerprint
        ? { pluginCandidateFingerprint: resolvedPluginState.pluginCandidateFingerprint }
        : {}),
      accountId: accountKey,
      plugin,
      runtime,
    }))
  ) {
    return;
  }

  let next = { ...cfg };
  const prevCfg = cfg;
  if (deleteConfig) {
    if (!plugin.config.deleteAccount) {
      runtime.error(
        `${formatUnsupportedChannelActionMessage({ channel, action: "delete" })} Use ${formatCliCommand("openclaw channels remove --channel " + channel)} to disable it without deleting config.`,
      );
      runtime.exit(1);
      return;
    }
    next = plugin.config.deleteAccount({
      cfg: next,
      accountId: resolvedAccountId,
    });
    await plugin.lifecycle?.onAccountRemoved?.({
      prevCfg,
      accountId: resolvedAccountId,
      runtime,
    });
  } else {
    if (!plugin.config.setAccountEnabled) {
      runtime.error(
        `${formatUnsupportedChannelActionMessage({ channel, action: "disable" })} Use ${formatCliCommand("openclaw channels remove --channel " + channel + " --delete")} only if you want to remove config.`,
      );
      runtime.exit(1);
      return;
    }
    next = plugin.config.setAccountEnabled({
      cfg: next,
      accountId: resolvedAccountId,
      enabled: false,
    });
    await plugin.lifecycle?.onAccountConfigChanged?.({
      prevCfg,
      nextCfg: next,
      accountId: resolvedAccountId,
      runtime,
    });
  }

  const shouldMovePluginInstalls = Boolean(
    next.plugins?.installs && Object.keys(next.plugins.installs).length > 0,
  );
  if (shouldMovePluginInstalls) {
    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig: next,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    next = committed.config;
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      reason: "source-changed",
      installRecords: committed.installRecords,
      logger: { warn: (message) => runtime.log(message) },
    });
  } else {
    await replaceConfigFile({
      nextConfig: next,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (resolvedPluginState?.pluginInstalled) {
      await refreshPluginRegistryAfterConfigMutation({
        config: next,
        reason: "source-changed",
        logger: { warn: (message) => runtime.log(message) },
      });
    }
  }
  if (useWizard && prompter) {
    await prompter.outro(
      deleteConfig
        ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".`
        : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".`
        : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`,
    );
  }
}
