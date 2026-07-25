// Channel plugin catalog tests cover plugin catalog entries and metadata normalization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => []),
);

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

import { getChannelPluginCatalogEntry, listRawChannelPluginCatalogEntries } from "./catalog.js";

beforeEach(() => {
  listChannelCatalogEntriesMock.mockReset().mockReturnValue([]);
});

describe("channel plugin catalog", () => {
  it("keeps the runtime-preferred candidate when one channel has duplicate plugin owners", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "telegram",
        origin: "global",
        rootDir: "/tmp/global-telegram",
        packageName: "telegram-global",
        preferredRuntimeOwner: true,
        runtimeOwnerRank: 2,
        channel: {
          id: "telegram",
          label: "Installed Telegram",
          selectionLabel: "Installed Telegram",
          docsPath: "/channels/telegram",
          blurb: "recorded global override",
        },
        install: { npmSpec: "telegram-global" },
      },
      {
        pluginId: "telegram",
        origin: "workspace",
        rootDir: "/tmp/workspace-telegram",
        packageName: "telegram-workspace",
        preferredRuntimeOwner: false,
        runtimeOwnerRank: 4,
        channel: {
          id: "telegram",
          label: "Workspace Telegram",
          selectionLabel: "Workspace Telegram",
          docsPath: "/channels/telegram",
          blurb: "workspace duplicate",
        },
        install: { localPath: "/tmp/workspace-telegram" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    const entry = getChannelPluginCatalogEntry("telegram", {
      catalogPaths: ["/tmp/openclaw-channel-catalog-empty.json"],
      officialCatalogPaths: ["/tmp/openclaw-channel-catalog-empty-official.json"],
    });

    expect(entry?.origin).toBe("global");
    expect(entry?.preferredRuntimeOwner).toBe(true);
  });

  it("omits a nonwinning duplicate when it advertises a different channel id", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "chat-plugin",
        origin: "global",
        rootDir: "/tmp/global-chat",
        preferredRuntimeOwner: true,
        runtimeOwnerRank: 2,
        channel: {
          id: "current-chat",
          label: "Current Chat",
          selectionLabel: "Current Chat",
          docsPath: "/channels/current-chat",
          blurb: "runtime winner",
        },
        install: { npmSpec: "chat-plugin" },
      },
      {
        pluginId: "chat-plugin",
        origin: "workspace",
        rootDir: "/tmp/workspace-chat",
        preferredRuntimeOwner: false,
        runtimeOwnerRank: 4,
        channel: {
          id: "next-chat",
          label: "Next Chat",
          selectionLabel: "Next Chat",
          docsPath: "/channels/next-chat",
          blurb: "overridden candidate",
        },
        install: { npmSpec: "chat-plugin", localPath: "/tmp/workspace-chat" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    const entries = listRawChannelPluginCatalogEntries({
      catalogPaths: ["/tmp/openclaw-channel-catalog-empty.json"],
      officialCatalogPaths: ["/tmp/openclaw-channel-catalog-empty-official.json"],
    });

    expect(entries.some((entry) => entry.id === "current-chat")).toBe(true);
    expect(entries.some((entry) => entry.id === "next-chat")).toBe(false);
  });

  it("omits an unloadable duplicate rejected by runtime validation", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "chat-plugin",
        origin: "config",
        rootDir: "/tmp/config-incompatible",
        packageName: "chat-plugin-config",
        preferredRuntimeOwner: false,
        channel: {
          id: "incompatible-chat",
          label: "Incompatible Chat",
          selectionLabel: "Incompatible Chat",
          docsPath: "/channels/incompatible-chat",
          blurb: "rejected runtime candidate",
        },
        install: { localPath: "/tmp/config-incompatible" },
      },
      {
        pluginId: "chat-plugin",
        origin: "workspace",
        rootDir: "/tmp/workspace-working",
        packageName: "chat-plugin-workspace",
        preferredRuntimeOwner: true,
        runtimeOwnerRank: 1,
        channel: {
          id: "working-chat",
          label: "Working Chat",
          selectionLabel: "Working Chat",
          docsPath: "/channels/working-chat",
          blurb: "runtime winner",
        },
        install: { localPath: "/tmp/workspace-working" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    const entries = listRawChannelPluginCatalogEntries({
      catalogPaths: ["/tmp/openclaw-channel-catalog-empty.json"],
      officialCatalogPaths: ["/tmp/openclaw-channel-catalog-empty-official.json"],
    });

    expect(entries.some((entry) => entry.id === "incompatible-chat")).toBe(false);
    expect(entries.some((entry) => entry.id === "working-chat")).toBe(true);
  });

  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };

    const wecom = getChannelPluginCatalogEntry("wecom", options);
    expect(wecom?.id).toBe("wecom");
    expect(wecom?.pluginId).toBe("wecom-openclaw-plugin");
    expect(wecom?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(wecom?.install?.npmSpec).toBe("@wecom/wecom-openclaw-plugin@2026.5.7");

    const yuanbao = getChannelPluginCatalogEntry("yuanbao", options);
    expect(yuanbao?.id).toBe("yuanbao");
    expect(yuanbao?.pluginId).toBe("openclaw-plugin-yuanbao");
    expect(yuanbao?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(yuanbao?.install?.npmSpec).toBe("openclaw-plugin-yuanbao@2.15.0");
  });

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "telegram",
        origin: "config",
        rootDir: "/tmp/config-telegram",
        packageName: "telegram-shadow",
        preferredRuntimeOwner: true,
        runtimeOwnerRank: 0,
        channel: {
          id: "telegram",
          label: "Telegram Shadow",
          selectionLabel: "Telegram Shadow",
          docsPath: "/channels/telegram",
          blurb: "shadow",
        },
        install: { localPath: "/tmp/config-telegram" },
      },
      {
        pluginId: "telegram",
        origin: "bundled",
        rootDir: "/tmp/bundled-telegram",
        packageName: "@openclaw/telegram",
        preferredRuntimeOwner: false,
        runtimeOwnerRank: 3,
        channel: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "bundled",
        },
        install: { npmSpec: "@openclaw/telegram@1.0.0" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    expect(
      getChannelPluginCatalogEntry("telegram", {
        excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });
});
