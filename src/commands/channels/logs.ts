// Implements channel-scoped tailing of the OpenClaw log file.
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { normalizeChannelId as normalizeBundledChannelId } from "../../channels/registry.js";
import { readFileWindowFully } from "../../infra/file-read.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { resolveLogFile } from "../../logging/log-tail.js";
import { parseLogLine } from "../../logging/parse-log-line.js";
import { listManifestChannelContributionIds } from "../../plugins/manifest-contribution-ids.js";
import { loadPluginRegistrySnapshot } from "../../plugins/plugin-registry.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

type LogLine = ReturnType<typeof parseLogLine>;

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

type ChannelLogFilter = {
  channel: string;
  knownScopeOwnerIds: Set<string>;
  matchingScopeOwnerIds: Set<string>;
};

function resolveManifestLogScopeOwners() {
  const index = loadPluginRegistrySnapshot({ env: process.env });
  const channelIds = new Set(
    listManifestChannelContributionIds({
      index,
      includeDisabled: true,
      env: process.env,
    }),
  );
  const pluginChannelsByScopeOwnerId = new Map<string, Set<string>>();
  for (const plugin of index.plugins) {
    const pluginId = normalizeLowercaseStringOrEmpty(plugin.pluginId);
    if (pluginId) {
      pluginChannelsByScopeOwnerId.set(
        pluginId,
        new Set(
          (plugin.contributions?.channels ?? [])
            .map((channelId) => normalizeLowercaseStringOrEmpty(channelId))
            .filter(Boolean),
        ),
      );
    }
  }
  return { channelIds, pluginChannelsByScopeOwnerId };
}

function resolveLogScopeOwnerIds(params: {
  channel: string;
  channelIds: Set<string>;
  pluginChannelsByScopeOwnerId: Map<string, Set<string>>;
}): { knownScopeOwnerIds: Set<string>; matchingScopeOwnerIds: Set<string> } {
  const knownScopeOwnerIds = new Set([...params.channelIds, params.channel]);
  const matchingScopeOwnerIds = new Set([params.channel]);
  for (const [pluginId, ownedChannelIds] of params.pluginChannelsByScopeOwnerId) {
    knownScopeOwnerIds.add(pluginId);
    if (ownedChannelIds.has(params.channel)) {
      matchingScopeOwnerIds.add(pluginId);
    }
  }
  return { knownScopeOwnerIds, matchingScopeOwnerIds };
}

function parseChannelFilter(raw?: string): ChannelLogFilter {
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (!trimmed || trimmed === "all") {
    return {
      channel: "all",
      knownScopeOwnerIds: new Set(),
      matchingScopeOwnerIds: new Set(),
    };
  }
  const { channelIds, pluginChannelsByScopeOwnerId } = resolveManifestLogScopeOwners();
  const bundled = normalizeBundledChannelId(trimmed);
  const channel = bundled === trimmed || channelIds.has(trimmed) ? trimmed : (bundled ?? "all");
  return {
    channel,
    ...resolveLogScopeOwnerIds({ channel, channelIds, pluginChannelsByScopeOwnerId }),
  };
}

function matchesChannel(line: NonNullable<LogLine>, filter: ChannelLogFilter) {
  const { channel, knownScopeOwnerIds, matchingScopeOwnerIds } = filter;
  if (channel === "all") {
    return true;
  }
  const matchesScopeOwner = (segment: string, ownerId: string) =>
    segment === ownerId || segment.startsWith(`${ownerId}-`) || segment.startsWith(`${ownerId}:`);
  const matchesChannelToken = (value?: string) =>
    value?.split("/").some((segment) => {
      const knownMatches = Array.from(knownScopeOwnerIds).filter((ownerId) =>
        matchesScopeOwner(segment, ownerId),
      );
      if (knownMatches.length === 0) {
        return false;
      }
      // Longest-owner assignment keeps nested plugin IDs such as `foo-tools`
      // from leaking into the shorter selected `foo` scope.
      const longestOwnerLength = Math.max(...knownMatches.map((ownerId) => ownerId.length));
      return knownMatches.some(
        (ownerId) => ownerId.length === longestOwnerLength && matchingScopeOwnerIds.has(ownerId),
      );
    }) ?? false;
  return matchesChannelToken(line.subsystem) || matchesChannelToken(line.module);
}

function parseLinesOption(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LIMIT;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error("--lines must be a positive integer.");
  }
  return parsed;
}

async function readTailLines(file: string, limit: number): Promise<string[]> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    return [];
  }
  const size = stat.size;
  const start = Math.max(0, size - MAX_BYTES);
  const handle = await fs.open(file, "r");
  try {
    let prefix = "";
    if (start > 0) {
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }
    const length = Math.max(0, size - start);
    if (length === 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    const bytesRead = await readFileWindowFully(handle, buffer, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    let lines = text.split("\n");
    if (start > 0 && prefix !== "\n") {
      lines = lines.slice(1);
    }
    if (lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }
    return lines;
  } finally {
    await handle.close();
  }
}

/** Print or serialize recent log lines matching one channel subsystem/module. */
export async function channelsLogsCommand(
  opts: ChannelsLogsOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const filter = parseChannelFilter(opts.channel);
  const channel = filter.channel;
  const limit = parseLinesOption(opts.lines);

  const file = await resolveLogFile(getResolvedLoggerSettings().file);
  const rawLines = await readTailLines(file, limit * 4);
  const parsed = rawLines
    .map(parseLogLine)
    .filter((line): line is NonNullable<LogLine> => Boolean(line));
  const filtered = parsed.filter((line) => matchesChannel(line, filter));
  const lines = filtered.slice(Math.max(0, filtered.length - limit));

  if (opts.json) {
    writeRuntimeJson(runtime, { file, channel, lines });
    return;
  }

  runtime.log(theme.info(`Log file: ${file}`));
  if (channel !== "all") {
    runtime.log(theme.info(`Channel: ${channel}`));
  }
  if (lines.length === 0) {
    runtime.log(theme.muted("No matching log lines."));
    return;
  }
  for (const line of lines) {
    const ts = line.time ? `${line.time} ` : "";
    const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
    runtime.log(`${ts}${level}${line.message}`.trim());
  }
}
