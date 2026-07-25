// Maintains channel catalog entries advertised by plugins.
import { normalizeOptionalString as resolveOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginPackageChannel, PluginPackageInstall } from "./manifest.js";
import { resolvePluginCandidateDuplicatePrecedenceRank } from "./plugin-candidate-precedence.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginChannelCatalogEntry = {
  pluginId: string;
  origin: PluginOrigin;
  packageName?: string;
  workspaceDir?: string;
  rootDir: string;
  channel: PluginPackageChannel;
  install?: PluginPackageInstall;
  preferredRuntimeOwner?: boolean;
  runtimeOwnerRank?: number;
};

export function listChannelCatalogEntries(
  params: {
    origin?: PluginOrigin;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    extraPaths?: string[];
    /**
     * Optional override.  When omitted and `origin !== "bundled"`, the persisted
     * plugin install ledger is loaded synchronously so that npm-installed
     * channels stored outside the discovery roots are visible to the catalog.
     * Bundled-only callers skip the load to avoid the disk read.
     */
    installRecords?: Record<string, PluginInstallRecord>;
    discovery?: PluginDiscoveryResult;
  } = {},
): PluginChannelCatalogEntry[] {
  const installRecords = resolveInstallRecords(params);
  const discovery =
    params.discovery ??
    discoverOpenClawPlugins({
      workspaceDir: params.workspaceDir,
      env: params.env,
      extraPaths: params.extraPaths,
      ...(installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}),
    });
  const env = params.env ?? process.env;
  const pluginIdCandidateCounts = new Map<string, number>();
  for (const candidate of discovery.candidates) {
    const pluginId = resolveChannelCatalogPluginId(candidate);
    if (pluginId && candidate.packageManifest?.channel?.id) {
      pluginIdCandidateCounts.set(pluginId, (pluginIdCandidateCounts.get(pluginId) ?? 0) + 1);
    }
  }
  const duplicatePluginIds = new Set(
    Array.from(pluginIdCandidateCounts)
      .filter(([, count]) => count > 1)
      .map(([pluginId]) => pluginId),
  );
  const runtimeWinnerByPluginId = new Map<string, PluginDiscoveryResult["candidates"][number]>();
  const runtimeOwnerRankByCandidate = new Map<
    PluginDiscoveryResult["candidates"][number],
    number
  >();
  for (const candidate of discovery.candidates) {
    const pluginId = resolveChannelCatalogPluginId(candidate);
    if (!pluginId || !duplicatePluginIds.has(pluginId)) {
      continue;
    }
    const validated = loadPluginManifestRegistry({
      candidates: [candidate],
      env,
      installRecords: installRecords ?? {},
      ...(params.extraPaths?.length
        ? { config: { plugins: { load: { paths: params.extraPaths } } } }
        : {}),
    }).plugins.some(
      (record) =>
        record.id === pluginId &&
        record.origin === candidate.origin &&
        record.rootDir === candidate.rootDir &&
        record.source === candidate.source,
    );
    if (!validated) {
      continue;
    }
    const candidateRank = resolvePluginCandidateDuplicatePrecedenceRank({
      pluginId,
      candidate,
      env,
      installRecords: installRecords ?? {},
    });
    runtimeOwnerRankByCandidate.set(candidate, candidateRank);
    const existing = runtimeWinnerByPluginId.get(pluginId);
    if (
      !existing ||
      candidateRank < (runtimeOwnerRankByCandidate.get(existing) ?? Number.POSITIVE_INFINITY)
    ) {
      runtimeWinnerByPluginId.set(pluginId, candidate);
    }
  }
  return discovery.candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const pluginId = resolveChannelCatalogPluginId(candidate);
    if (!pluginId) {
      return [];
    }
    const preferredRuntimeOwner = !duplicatePluginIds.has(pluginId)
      ? undefined
      : runtimeWinnerByPluginId.get(pluginId) === candidate;
    const runtimeOwnerRank = runtimeOwnerRankByCandidate.get(candidate);
    return [
      {
        pluginId,
        origin: candidate.origin,
        packageName: candidate.packageName,
        workspaceDir: candidate.workspaceDir,
        rootDir: candidate.rootDir,
        channel,
        ...(preferredRuntimeOwner !== undefined ? { preferredRuntimeOwner } : {}),
        ...(runtimeOwnerRank !== undefined ? { runtimeOwnerRank } : {}),
        ...(candidate.packageManifest?.install
          ? { install: candidate.packageManifest.install }
          : {}),
      },
    ];
  });
}

function resolveChannelCatalogPluginId(
  candidate: PluginDiscoveryResult["candidates"][number],
): string | undefined {
  return (
    resolveOptionalString(candidate.bundledManifest?.id) ??
    resolveOptionalString(candidate.bundledManifestId) ??
    resolveOptionalString(candidate.packageManifest?.plugin?.id) ??
    resolveOptionalString(candidate.idHint)
  );
}

function resolveInstallRecords(params: {
  origin?: PluginOrigin;
  env?: NodeJS.ProcessEnv;
  installRecords?: Record<string, PluginInstallRecord>;
}): Record<string, PluginInstallRecord> | undefined {
  if (params.installRecords) {
    return params.installRecords;
  }
  if (params.origin === "bundled") {
    return undefined;
  }
  try {
    return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
  } catch {
    return undefined;
  }
}
