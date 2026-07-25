// Shared duplicate precedence for plugin discovery and metadata projections.
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
import type { PluginCandidate } from "./discovery.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";

export function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
  installPathOnly?: boolean;
}): boolean {
  if (params.candidate.origin !== "global" && params.candidate.origin !== "config") {
    return false;
  }
  const record = params.installRecords[params.pluginId];
  if (!record) {
    return false;
  }
  const candidatePaths = [
    params.candidate.rootDir,
    params.candidate.packageDir,
    params.candidate.source,
    params.candidate.setupSource,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const resolved = resolveUserPath(entry, params.env);
      return safeRealpathSync(resolved) ?? resolved;
    });
  // Security decisions must bind to the current install output. sourcePath can
  // legitimately identify path installs, but it can also survive a source switch.
  const trackedPaths = (
    params.installPathOnly ? [record.installPath] : [record.installPath, record.sourcePath]
  )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const resolved = resolveUserPath(entry, params.env);
      return safeRealpathSync(resolved) ?? resolved;
    });
  if (candidatePaths.length === 0 || trackedPaths.length === 0) {
    return false;
  }
  return trackedPaths.some((trackedPath) =>
    candidatePaths.some(
      (candidatePath) =>
        candidatePath === trackedPath ||
        isPathInside(trackedPath, candidatePath) ||
        isPathInside(candidatePath, trackedPath),
    ),
  );
}

export function resolvePluginCandidateDuplicatePrecedenceRank(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): number {
  if (params.candidate.origin === "config") {
    return 0;
  }
  if (
    params.candidate.origin === "bundled" &&
    isBundledPluginInsideDevSourceRoot({
      rootDir: params.candidate.rootDir,
      env: params.env,
    })
  ) {
    return 1;
  }
  if (
    params.candidate.origin === "global" &&
    matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      config: params.config,
      env: params.env,
      installRecords: params.installRecords,
    })
  ) {
    return 2;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids are reserved unless the operator explicitly overrides them.
    return 3;
  }
  if (params.candidate.origin === "workspace") {
    return 4;
  }
  return 5;
}
