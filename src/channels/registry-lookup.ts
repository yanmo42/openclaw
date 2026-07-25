// Cached lookup view for active channel plugin registry entries and aliases.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  ActivePluginChannelRegistration,
  ActivePluginChannelRegistry,
} from "../plugins/channel-registry-state.types.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getActivePluginChannelRegistrySnapshotFromState } from "../plugins/runtime-channel-state.js";

type RegisteredChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: ActivePluginChannelRegistration["plugin"] & {
    id?: string | null;
    meta?: {
      aliases?: readonly string[];
      markdownCapable?: boolean;
    } | null;
  };
};

type RegisteredChannelPluginLookup = {
  registry: ActivePluginChannelRegistry | null;
  channels: ActivePluginChannelRegistration[] | undefined;
  channelCount: number;
  version: number;
  entries: RegisteredChannelPluginEntry[];
  byKey: Map<string, RegisteredChannelPluginEntry>;
  byId: Map<string, RegisteredChannelPluginEntry>;
};

let registeredChannelPluginLookup: RegisteredChannelPluginLookup | undefined;

let manifestChannelOwnerLookup:
  | {
      snapshot: object;
      channels: ReadonlyMap<string, { canonicalId: string; pluginIds: readonly string[] }>;
    }
  | undefined;

function getManifestChannelOwnerMap():
  | ReadonlyMap<string, { canonicalId: string; pluginIds: readonly string[] }>
  | undefined {
  // This process-global projection must never consume a scoped workspace snapshot:
  // otherwise one workspace can reserve channel ids for unrelated routing contexts.
  const snapshot = getCurrentPluginMetadataSnapshot({ requireDefaultDiscoveryContext: true });
  if (!snapshot) {
    return undefined;
  }
  if (manifestChannelOwnerLookup?.snapshot === snapshot) {
    return manifestChannelOwnerLookup.channels;
  }
  const metadata = snapshot as {
    index?: { plugins?: readonly { pluginId: string; enabled: boolean }[] };
    owners?: { channels?: unknown };
  };
  const owners = metadata.owners;
  const channels = owners?.channels;
  if (!channels || typeof (channels as { has?: unknown }).has !== "function") {
    return undefined;
  }
  const enabledPluginIds = new Set(
    (metadata.index?.plugins ?? [])
      .filter((plugin) => plugin.enabled)
      .map((plugin) => plugin.pluginId),
  );
  const enabledChannels = new Map<string, { canonicalId: string; pluginIds: readonly string[] }>();
  for (const [channelId, pluginIds] of channels as ReadonlyMap<string, readonly string[]>) {
    const canonicalId = normalizeOptionalString(channelId);
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!canonicalId || !normalizedChannelId) {
      continue;
    }
    const enabledOwners = pluginIds.filter((pluginId) => enabledPluginIds.has(pluginId));
    if (enabledOwners.length > 0) {
      const existing = enabledChannels.get(normalizedChannelId);
      enabledChannels.set(normalizedChannelId, {
        canonicalId: existing?.canonicalId ?? canonicalId,
        pluginIds: [...(existing?.pluginIds ?? []), ...enabledOwners],
      });
    }
  }
  // Metadata includes disabled manifests for control-plane inspection. Only
  // active owners may reserve exact ids ahead of bundled aliases at runtime.
  manifestChannelOwnerLookup = { snapshot, channels: enabledChannels };
  return enabledChannels;
}

function setLookupEntry(
  map: Map<string, RegisteredChannelPluginEntry>,
  key: string | undefined,
  entry: RegisteredChannelPluginEntry,
): void {
  // First writer wins so canonical ids keep priority over later aliases.
  if (key && !map.has(key)) {
    map.set(key, entry);
  }
}

function buildRegisteredChannelPluginLookup(): RegisteredChannelPluginLookup {
  const { registry, version } = getActivePluginChannelRegistrySnapshotFromState();
  const channels = Array.isArray(registry?.channels) ? registry.channels : undefined;
  const channelCount = channels?.length ?? 0;
  const cached = registeredChannelPluginLookup;
  if (
    cached &&
    cached.registry === registry &&
    cached.channels === channels &&
    cached.channelCount === channelCount &&
    cached.version === version
  ) {
    return cached;
  }
  const entries = channelCount > 0 ? (channels as RegisteredChannelPluginEntry[]) : [];
  const byKey = new Map<string, RegisteredChannelPluginEntry>();
  const byId = new Map<string, RegisteredChannelPluginEntry>();
  for (const entry of entries) {
    const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "");
    setLookupEntry(byKey, id, entry);
    setLookupEntry(byId, id, entry);
  }
  // Populate aliases only after every canonical id is known so an earlier
  // plugin alias cannot shadow a later plugin's exact id.
  for (const entry of entries) {
    for (const alias of entry.plugin.meta?.aliases ?? []) {
      setLookupEntry(byKey, normalizeOptionalLowercaseString(alias), entry);
    }
  }
  registeredChannelPluginLookup = {
    registry,
    channels,
    channelCount,
    version,
    entries,
    byKey,
    byId,
  };
  return registeredChannelPluginLookup;
}

/** Lists active channel plugin registrations from the current registry snapshot. */
export function listRegisteredChannelPluginEntries(): RegisteredChannelPluginEntry[] {
  return buildRegisteredChannelPluginLookup().entries;
}

/** Lists canonical ids from active registrations and process-current manifest metadata. */
export function listKnownChannelPluginIds(): string[] {
  const ids = new Set(
    buildRegisteredChannelPluginLookup().entries.flatMap((entry) => {
      const id = normalizeOptionalString(entry.plugin.id);
      return id ? [id] : [];
    }),
  );
  for (const entry of getManifestChannelOwnerMap()?.values() ?? []) {
    ids.add(entry.canonicalId);
  }
  return [...ids];
}

/** Resolves an exact known channel id while preserving its canonical spelling. */
export function resolveKnownChannelPluginId(id: string): string | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  const registeredId = normalizeOptionalString(
    buildRegisteredChannelPluginLookup().byId.get(normalizedId)?.plugin.id,
  );
  return registeredId ?? getManifestChannelOwnerMap()?.get(normalizedId)?.canonicalId;
}

/** Returns whether process-stable manifest metadata owns an exact canonical channel id. */
export function isKnownChannelPluginId(id: string): boolean {
  return resolveKnownChannelPluginId(id) !== undefined;
}

/** Returns whether an exact channel id is known to an owner other than the supplied plugin id. */
export function hasKnownChannelPluginOwnerOtherThan(id: string, pluginId: string): boolean {
  const normalizedId = normalizeOptionalLowercaseString(id);
  const normalizedPluginId = normalizeOptionalLowercaseString(pluginId);
  if (!normalizedId || !normalizedPluginId) {
    return false;
  }
  const registeredOwner = buildRegisteredChannelPluginLookup().byId.get(normalizedId)?.pluginId;
  const manifestOwners = getManifestChannelOwnerMap()?.get(normalizedId)?.pluginIds ?? [];
  return [registeredOwner, ...manifestOwners].some((owner) => {
    const normalizedOwner = normalizeOptionalLowercaseString(owner);
    return normalizedOwner !== undefined && normalizedOwner !== normalizedPluginId;
  });
}

/** Finds an active channel plugin registration by normalized id or alias. */
export function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): RegisteredChannelPluginEntry | undefined {
  return buildRegisteredChannelPluginLookup().byKey.get(normalizedKey);
}

/** Finds an active channel plugin registration by its canonical plugin id. */
export function findRegisteredChannelPluginEntryById(
  id: string,
): RegisteredChannelPluginEntry | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return buildRegisteredChannelPluginLookup().byId.get(normalizedId);
}
