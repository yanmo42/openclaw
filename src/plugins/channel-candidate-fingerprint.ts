// Builds opaque channel candidate identities from process-stable loader metadata.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginOrigin } from "./plugin-origin.types.js";

/** Identifies one loaded plugin candidate without exposing its source path over RPC. */
export function resolveChannelPluginCandidateFingerprint(params: {
  pluginId?: string | null;
  origin?: PluginOrigin | null;
  source?: string | null;
  rootDir?: string | null;
  version?: string | null;
}): string | undefined {
  const pluginId = normalizeOptionalString(params.pluginId);
  const source = normalizeOptionalString(params.source);
  if (!pluginId || !source) {
    return undefined;
  }
  const identity = JSON.stringify([
    pluginId,
    normalizeOptionalString(params.origin) ?? "",
    source,
    normalizeOptionalString(params.rootDir) ?? "",
    normalizeOptionalString(params.version) ?? "",
  ]);
  return createHash("sha256").update(identity).digest("hex");
}
