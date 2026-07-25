// Channel plugin resolution tests cover trusted catalog lookup, install prompts, and setup plugin snapshots.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resolveChannelPluginCandidateFingerprint } from "../../plugins/channel-candidate-fingerprint.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
  listChannelPluginCatalogEntries: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  getChannelPlugin: vi.fn(),
  getLoadedChannelPluginCandidateFingerprint: vi.fn(),
  getLoadedChannelPluginOrigin: vi.fn(),
  getLoadedChannelPluginOwnerId: vi.fn(),
  normalizeChannelId: vi.fn((value: unknown) => {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    return normalized === "teams" ? "msteams" : normalized || null;
  }),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  createClackPrompter: vi.fn(() => ({}) as never),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  getLoadedChannelPluginCandidateFingerprint: mocks.getLoadedChannelPluginCandidateFingerprint,
  getLoadedChannelPluginOrigin: mocks.getLoadedChannelPluginOrigin,
  getLoadedChannelPluginOwnerId: mocks.getLoadedChannelPluginOwnerId,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("./plugin-install.js", () => ({
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

import { resolveInstallableChannelPlugin } from "./channel-plugin-resolution.js";

function createCatalogEntry(params: {
  id: string;
  pluginId: string;
  origin?: "workspace" | "bundled";
  aliases?: string[];
}): ChannelPluginCatalogEntry {
  return {
    id: params.id,
    pluginId: params.pluginId,
    origin: params.origin,
    meta: {
      id: params.id,
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram channel",
      ...(params.aliases ? { aliases: params.aliases } : {}),
    },
    install: {
      npmSpec: params.pluginId,
    },
  };
}

function createPlugin(id: string): ChannelPlugin {
  return { id } as ChannelPlugin;
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock to have at least one call");
  }
  return call[0];
}

describe("resolveInstallableChannelPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.getLoadedChannelPluginCandidateFingerprint.mockReturnValue(undefined);
    mocks.getLoadedChannelPluginOrigin.mockReturnValue(undefined);
    mocks.getLoadedChannelPluginOwnerId.mockReturnValue(undefined);
    mocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    mocks.normalizeChannelId.mockImplementation((value: unknown) => {
      if (typeof value !== "string") {
        return null;
      }
      const normalized = value.trim();
      return normalized === "teams" ? "msteams" : normalized || null;
    });
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: {},
      installed: false,
    });
  });

  it("ignores untrusted workspace channel shadows during setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const bundledEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "telegram",
      origin: "bundled",
    });
    const bundledPlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockImplementation(() => [workspaceEntry]);
    mocks.getChannelPluginCatalogEntry.mockImplementation(
      (_channel: string, opts?: { excludePluginRefs?: Array<{ pluginId: string }> }) =>
        opts?.excludePluginRefs?.some((entry) => entry.pluginId === "evil-telegram-shadow")
          ? bundledEntry
          : undefined,
    );
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "telegram" ? [{ plugin: bundledPlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("telegram");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    const snapshotRequest = firstMockArg(
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
    ) as { channel?: string; pluginId?: string; workspaceDir?: string };
    expect(snapshotRequest?.channel).toBe("telegram");
    expect(snapshotRequest?.pluginId).toBe("telegram");
    expect(snapshotRequest?.workspaceDir).toBe("/tmp/workspace");
  });

  it("keeps trusted workspace channel plugins eligible for setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const workspacePlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "evil-telegram-shadow" ? [{ plugin: workspacePlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["evil-telegram-shadow"],
        },
      },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("evil-telegram-shadow");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    const snapshotRequest = firstMockArg(
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
    ) as { channel?: string; pluginId?: string; workspaceDir?: string };
    expect(snapshotRequest?.channel).toBe("telegram");
    expect(snapshotRequest?.pluginId).toBe("evil-telegram-shadow");
    expect(snapshotRequest?.workspaceDir).toBe("/tmp/workspace");
  });

  it("keeps an exact catalog id when it collides with a bundled alias", async () => {
    const catalogEntry = createCatalogEntry({
      id: "teams",
      pluginId: "@vendor/teams",
      origin: "workspace",
    });
    const plugin = createPlugin("teams");
    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ channel }: { channel?: string }) => ({
        channels: channel === "teams" ? [{ plugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["@vendor/teams"],
        },
      },
      runtime: {} as never,
      rawChannel: "teams",
      channelId: "msteams",
      allowInstall: false,
    });

    expect(result.channelId).toBe("teams");
    expect(result.plugin).toBe(plugin);
  });

  it("fingerprints a scoped plugin with its candidate-stable package version", async () => {
    const catalogEntry = createCatalogEntry({
      id: "teams",
      pluginId: "@vendor/teams",
      origin: "workspace",
    });
    const plugin = createPlugin("teams");
    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [
        {
          plugin,
          pluginId: "@vendor/teams",
          origin: "workspace",
          source: "/plugins/teams/index.js",
          rootDir: "/plugins/teams",
          pluginVersion: "manifest-version",
          pluginCandidateVersion: "package-version",
        },
      ],
      channelSetups: [],
    });

    const result = await resolveInstallableChannelPlugin({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["@vendor/teams"],
        },
      },
      runtime: {} as never,
      rawChannel: "teams",
      allowInstall: false,
    });

    expect(result.pluginCandidateFingerprint).toBe(
      resolveChannelPluginCandidateFingerprint({
        pluginId: "@vendor/teams",
        origin: "workspace",
        source: "/plugins/teams/index.js",
        rootDir: "/plugins/teams",
        version: "package-version",
      }),
    );
  });

  it("keeps an exact loaded id when another catalog entry claims it as an alias", async () => {
    const aliasOwner = createCatalogEntry({
      id: "msteams",
      pluginId: "@openclaw/msteams",
      origin: "bundled",
      aliases: ["teams"],
    });
    const exactPlugin = createPlugin("teams");
    mocks.listChannelPluginCatalogEntries.mockReturnValue([aliasOwner]);
    mocks.getChannelPlugin.mockReturnValue(exactPlugin);
    mocks.getLoadedChannelPluginOwnerId.mockReturnValue("teams-workspace");
    mocks.normalizeChannelId.mockReturnValue("teams");

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "teams",
      channelId: "teams",
      allowInstall: false,
    });

    expect(result.channelId).toBe("teams");
    expect(result.plugin).toBe(exactPlugin);
    expect(result.pluginId).toBe("teams-workspace");
    expect(result.catalogEntry).toBeUndefined();
  });

  it("returns the exact loaded plugin candidate fingerprint", async () => {
    const plugin = createPlugin("teams");
    mocks.getChannelPlugin.mockReturnValue(plugin);
    mocks.getLoadedChannelPluginCandidateFingerprint.mockReturnValue("candidate-fingerprint");
    mocks.normalizeChannelId.mockReturnValue("teams");

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "teams",
      allowInstall: false,
    });

    expect(result.plugin).toBe(plugin);
    expect(result.pluginCandidateFingerprint).toBe("candidate-fingerprint");
  });

  it("derives an exact loaded id before resolving a raw-only catalog alias", async () => {
    const aliasOwner = createCatalogEntry({
      id: "msteams",
      pluginId: "@openclaw/msteams",
      origin: "bundled",
      aliases: ["teams"],
    });
    const exactPlugin = createPlugin("teams");
    mocks.listChannelPluginCatalogEntries.mockReturnValue([aliasOwner]);
    mocks.getChannelPlugin.mockReturnValue(exactPlugin);
    mocks.normalizeChannelId.mockReturnValue("teams");

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "teams",
      allowInstall: false,
    });

    expect(result.channelId).toBe("teams");
    expect(result.plugin).toBe(exactPlugin);
    expect(result.catalogEntry).toBeUndefined();
  });

  it("returns an existing plugin that lacks the requested capability without reinstalling", async () => {
    const catalogEntry = createCatalogEntry({
      id: "openclaw-weixin",
      pluginId: "@tencent-weixin/openclaw-weixin",
      origin: "bundled",
    });
    const installedPlugin = createPlugin("openclaw-weixin");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.getChannelPlugin.mockReturnValue(installedPlugin);

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "openclaw-weixin",
      allowInstall: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(result.plugin).toBe(installedPlugin);
    expect(result.pluginInstalled).toBe(false);
    expect(result.supportsRequestedCapability).toBe(false);
    expect(mocks.ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
  });

  it("returns a scoped installed plugin that lacks the requested capability without reinstalling", async () => {
    const catalogEntry = createCatalogEntry({
      id: "openclaw-weixin",
      pluginId: "@tencent-weixin/openclaw-weixin",
      origin: "bundled",
    });
    const scopedPlugin = createPlugin("openclaw-weixin");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [{ plugin: scopedPlugin }],
      channelSetups: [],
    });

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "openclaw-weixin",
      allowInstall: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(result.plugin).toBe(scopedPlugin);
    expect(result.pluginInstalled).toBe(false);
    expect(result.supportsRequestedCapability).toBe(false);
    expect(mocks.ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
  });

  it("still offers install when only a setup fallback lacks the requested capability", async () => {
    const catalogEntry = createCatalogEntry({
      id: "demo-directory",
      pluginId: "@demo/directory",
      origin: "bundled",
    });
    const setupOnlyPlugin = createPlugin("demo-directory");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [],
      channelSetups: [{ plugin: setupOnlyPlugin }],
    });
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
      cfg: { plugins: { entries: { "@demo/directory": { enabled: true } } } },
      installed: true,
      pluginId: "@demo/directory",
      status: "installed",
    });

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "demo-directory",
      allowInstall: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
    const installRequest = firstMockArg(mocks.ensureChannelSetupPluginInstalled) as {
      entry?: ChannelPluginCatalogEntry;
    };
    expect(installRequest?.entry).toBe(catalogEntry);
    expect(result.pluginInstalled).toBe(true);
  });
});
