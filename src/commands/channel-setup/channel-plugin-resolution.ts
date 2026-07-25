// Resolves or installs channel plugins needed by setup/onboarding flows.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listRawChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import {
  channelEntryHasExactId,
  findChannelEntryByIdOrAlias,
} from "../../channels/plugins/entry-resolution.js";
import {
  getChannelPlugin,
  getLoadedChannelPluginCandidateFingerprint,
  getLoadedChannelPluginOrigin,
  getLoadedChannelPluginOwnerId,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChannelPluginCandidateFingerprint } from "../../plugins/channel-candidate-fingerprint.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";
import {
  getTrustedChannelPluginCatalogEntry,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

type ChannelPluginSnapshot = {
  channels: ChannelPluginSnapshotEntry[];
  channelSetups: ChannelPluginSnapshotEntry[];
};

type ChannelPluginSnapshotEntry = {
  plugin: ChannelPlugin;
  pluginId?: string;
  origin?: PluginOrigin;
  source?: string;
  rootDir?: string;
  pluginVersion?: string;
  pluginCandidateVersion?: string;
};

type ResolveInstallableChannelPluginResult = {
  cfg: OpenClawConfig;
  channelId?: ChannelId;
  plugin?: ChannelPlugin;
  pluginId?: string;
  pluginOrigin?: string;
  pluginCandidateFingerprint?: string;
  catalogEntry?: ChannelPluginCatalogEntry;
  configChanged: boolean;
  pluginInstalled: boolean;
  supportsRequestedCapability?: boolean;
};

function resolveWorkspaceDir(cfg: OpenClawConfig) {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function resolveResolvedChannelId(params: {
  rawChannel?: string | null;
  catalogEntry?: ChannelPluginCatalogEntry;
}): ChannelId | undefined {
  if (params.catalogEntry) {
    return params.catalogEntry.id as ChannelId;
  }
  return normalizeChannelId(params.rawChannel) ?? undefined;
}

function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const entries = cfg
    ? listTrustedChannelPluginCatalogEntries({
        cfg,
        workspaceDir: resolveWorkspaceDir(cfg),
      })
    : listRawChannelPluginCatalogEntries({ excludeWorkspace: true });
  return findChannelEntryByIdOrAlias(entries, raw);
}

function findScopedChannelPlugin(
  snapshot: ChannelPluginSnapshot,
  channelId: ChannelId,
  supports: (plugin: ChannelPlugin) => boolean,
): ChannelPluginSnapshotEntry | undefined {
  const runtimeEntry = snapshot.channels.find((entry) => entry.plugin.id === channelId);
  if (runtimeEntry) {
    return runtimeEntry;
  }
  const setupEntry = snapshot.channelSetups.find((entry) => entry.plugin.id === channelId);
  return setupEntry && supports(setupEntry.plugin) ? setupEntry : undefined;
}

function resolveSnapshotCandidateFingerprint(
  entry: ChannelPluginSnapshotEntry,
): string | undefined {
  return resolveChannelPluginCandidateFingerprint({
    pluginId: entry.pluginId,
    origin: entry.origin,
    source: entry.source,
    rootDir: entry.rootDir,
    version: entry.pluginCandidateVersion,
  });
}

function loadScopedChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channelId: ChannelId;
  supports: (plugin: ChannelPlugin) => boolean;
  pluginId?: string;
  workspaceDir?: string;
}): ChannelPluginSnapshotEntry | undefined {
  const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
    cfg: params.cfg,
    runtime: params.runtime,
    channel: params.channelId,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    workspaceDir: params.workspaceDir,
  });
  return findScopedChannelPlugin(snapshot, params.channelId, params.supports);
}

function resolveActivePluginOwner(channelId: ChannelId, plugin: ChannelPlugin) {
  const loadedPluginId = getLoadedChannelPluginOwnerId(channelId);
  const pluginOrigin =
    getLoadedChannelPluginOrigin(channelId) ?? (loadedPluginId ? undefined : "bundled");
  const pluginCandidateFingerprint = getLoadedChannelPluginCandidateFingerprint(channelId);
  return {
    pluginId: loadedPluginId ?? plugin.id,
    ...(pluginOrigin ? { pluginOrigin } : {}),
    ...(pluginCandidateFingerprint ? { pluginCandidateFingerprint } : {}),
  };
}

/** Resolve an existing channel plugin, scoped setup plugin, or installable catalog entry. */
export async function resolveInstallableChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  rawChannel?: string | null;
  channelId?: ChannelId;
  allowInstall?: boolean;
  prompter?: WizardPrompter;
  supports?: (plugin: ChannelPlugin) => boolean;
}): Promise<ResolveInstallableChannelPluginResult> {
  const supports = params.supports ?? (() => true);
  let nextCfg = params.cfg;
  const workspaceDir = resolveWorkspaceDir(nextCfg);
  const rawCatalogEntry = params.rawChannel
    ? resolveCatalogChannelEntry(params.rawChannel, nextCfg)
    : undefined;
  const normalizedChannelId =
    params.channelId ??
    resolveResolvedChannelId({
      rawChannel: params.rawChannel,
    });
  // A loaded canonical id outranks another catalog entry's alias. Retain a
  // catalog match only when it is exact or agrees with the resolved plugin id.
  const catalogEntry =
    (rawCatalogEntry &&
    (!normalizedChannelId ||
      channelEntryHasExactId(rawCatalogEntry, params.rawChannel ?? "") ||
      rawCatalogEntry.id === normalizedChannelId)
      ? rawCatalogEntry
      : undefined) ??
    (normalizedChannelId
      ? getTrustedChannelPluginCatalogEntry(normalizedChannelId, {
          cfg: nextCfg,
          workspaceDir,
        })
      : undefined);
  const channelId = catalogEntry ? resolveResolvedChannelId({ catalogEntry }) : normalizedChannelId;
  if (!channelId) {
    return {
      cfg: nextCfg,
      catalogEntry,
      configChanged: false,
      pluginInstalled: false,
    };
  }

  const existing = getChannelPlugin(channelId);
  if (existing) {
    return {
      cfg: nextCfg,
      channelId,
      plugin: existing,
      ...resolveActivePluginOwner(channelId, existing),
      catalogEntry,
      configChanged: false,
      pluginInstalled: false,
      supportsRequestedCapability: supports(existing),
    };
  }

  const resolvedPluginId = catalogEntry?.pluginId;
  if (catalogEntry) {
    const scoped = loadScopedChannelPlugin({
      cfg: nextCfg,
      runtime: params.runtime,
      channelId,
      supports,
      pluginId: resolvedPluginId,
      workspaceDir,
    });
    if (scoped) {
      const pluginCandidateFingerprint = resolveSnapshotCandidateFingerprint(scoped);
      return {
        cfg: nextCfg,
        channelId,
        plugin: scoped.plugin,
        pluginId: scoped.pluginId ?? resolvedPluginId ?? scoped.plugin.id,
        ...((scoped.origin ?? catalogEntry.origin)
          ? { pluginOrigin: scoped.origin ?? catalogEntry.origin }
          : {}),
        ...(pluginCandidateFingerprint ? { pluginCandidateFingerprint } : {}),
        catalogEntry,
        configChanged: false,
        pluginInstalled: false,
        supportsRequestedCapability: supports(scoped.plugin),
      };
    }

    if (params.allowInstall !== false) {
      const installResult = await ensureChannelSetupPluginInstalled({
        cfg: nextCfg,
        entry: catalogEntry,
        prompter: params.prompter ?? createClackPrompter(),
        runtime: params.runtime,
        workspaceDir,
      });
      nextCfg = installResult.cfg;
      const installedPluginId = installResult.pluginId ?? resolvedPluginId;
      const installedEntry = installResult.installed
        ? loadScopedChannelPlugin({
            cfg: nextCfg,
            runtime: params.runtime,
            channelId,
            supports,
            pluginId: installedPluginId,
            workspaceDir: resolveWorkspaceDir(nextCfg),
          })
        : undefined;
      const pluginCandidateFingerprint = installedEntry
        ? resolveSnapshotCandidateFingerprint(installedEntry)
        : undefined;
      return {
        cfg: nextCfg,
        channelId,
        plugin: installedEntry?.plugin,
        ...(installedPluginId ? { pluginId: installedPluginId } : {}),
        ...((installedEntry?.origin ?? catalogEntry.origin)
          ? { pluginOrigin: installedEntry?.origin ?? catalogEntry.origin }
          : {}),
        ...(pluginCandidateFingerprint ? { pluginCandidateFingerprint } : {}),
        catalogEntry:
          installedPluginId && catalogEntry.pluginId !== installedPluginId
            ? { ...catalogEntry, pluginId: installedPluginId }
            : catalogEntry,
        configChanged: nextCfg !== params.cfg,
        pluginInstalled: installResult.installed,
        supportsRequestedCapability: installedEntry ? supports(installedEntry.plugin) : undefined,
      };
    }
  }

  return {
    cfg: nextCfg,
    channelId,
    catalogEntry,
    configChanged: false,
    pluginInstalled: false,
  };
}
