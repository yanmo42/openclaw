import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndexRecord,
} from "../plugins/installed-plugin-index-types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

type TestPluginOwner = {
  pluginId: string;
  enabled: boolean;
};

function createInstalledPluginRecord(plugin: TestPluginOwner): InstalledPluginIndexRecord {
  return {
    pluginId: plugin.pluginId,
    manifestPath: `/tmp/${plugin.pluginId}/openclaw.plugin.json`,
    manifestHash: "test",
    rootDir: `/tmp/${plugin.pluginId}`,
    origin: "global",
    enabled: plugin.enabled,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  };
}

export function setCurrentChannelOwnerMetadataForTest(params: {
  plugins: readonly TestPluginOwner[];
  channels: ReadonlyMap<string, readonly string[]>;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const config = params.config ?? {};
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const snapshot: PluginMetadataSnapshot = {
    policyHash,
    ...(params.pluginIds ? { pluginIds: params.pluginIds } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: params.plugins.map(createInstalledPluginRecord),
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: params.channels,
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: params.plugins.length,
      manifestPluginCount: 0,
    },
  };
  setCurrentPluginMetadataSnapshot(snapshot, {
    config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return snapshot;
}
