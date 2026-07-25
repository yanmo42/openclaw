// Channels remove tests cover config mutation, plugin catalog repair hints, and account removal behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks } from "./channels.mock-harness.js";
import {
  createExternalChatCatalogEntry,
  createExternalChatDeletePlugin,
} from "./channels.plugin-install.test-helpers.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

let channelsRemoveCommand: typeof import("./channels.js").channelsRemoveCommand;

type GatewayCallRequest = {
  method: string;
  params?: Record<string, unknown>;
};

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const registryRefreshMocks = vi.hoisted(() => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn<(request: GatewayCallRequest) => Promise<unknown>>(async () => ({
    stopped: true,
  })),
}));

const prompterMocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock("../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/catalog.js")>(
    "../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    listRawChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
  };
});

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
  };
});

vi.mock("./channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-setup/plugin-install.js")>(
    "./channel-setup/plugin-install.js",
  );
  const { createMockChannelSetupPluginInstallModule } =
    await import("./channels.plugin-install.test-helpers.js");
  return createMockChannelSetupPluginInstallModule(actual);
});

vi.mock("../plugins/registry-refresh.js", () => registryRefreshMocks);

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({
    confirm: prompterMocks.confirm,
  }),
}));

const runtime = createTestRuntime();

function firstWrittenChannelsConfig() {
  return configMocks.writeConfigFile.mock.calls[0]?.[0] as
    | { channels?: Record<string, unknown> }
    | undefined;
}

describe("channelsRemoveCommand", () => {
  beforeAll(async () => {
    ({ channelsRemoveCommand } = await import("./channels.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { nextConfig: unknown }) => {
        await configMocks.writeConfigFile(params.nextConfig);
      });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    registryRefreshMocks.refreshPluginRegistryAfterConfigMutation.mockClear();
    gatewayMocks.callGateway.mockClear();
    gatewayMocks.callGateway.mockResolvedValue({ stopped: true });
    prompterMocks.confirm.mockClear();
    prompterMocks.confirm.mockResolvedValue(true);
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves an exact plugin before confirming an alias-colliding removal target", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          teams: {
            enabled: true,
          },
        },
      },
    });
    const aliasPlugin = createChannelTestPluginBase({
      id: "msteams",
      label: "Microsoft Teams",
    });
    aliasPlugin.meta.aliases = ["teams"];
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          plugin: aliasPlugin,
          source: "test",
        },
      ]),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "teams",
        pluginId: "exact-teams-plugin",
        meta: {
          id: "teams",
          label: "Exact Teams",
          selectionLabel: "Exact Teams",
          docsPath: "/channels/teams",
          blurb: "exact teams channel",
        },
        install: {
          npmSpec: "exact-teams-plugin",
        },
      },
    ]);
    const exactPluginBase = createChannelTestPluginBase({
      id: "teams",
      label: "Exact Teams",
    });
    const setAccountEnabled = vi.fn(({ cfg }: { cfg: OpenClawConfig }) => cfg);
    const exactPlugin = {
      ...exactPluginBase,
      config: {
        ...exactPluginBase.config,
        setAccountEnabled,
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "exact-teams-plugin",
          plugin: exactPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "teams",
        account: "Work",
      },
      runtime,
      { hasFlags: true },
    );

    expect(prompterMocks.confirm).toHaveBeenCalledWith({
      message: 'Disable Exact Teams account "work"? (keeps config)',
      initialValue: true,
    });
    expect(setAccountEnabled).toHaveBeenCalledOnce();
  });

  it("asks users to add an external channel plugin before removing its account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel plugin "external-chat" is not installed. Run openclaw channels add --channel external-chat first.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("removes an external channel account when its plugin is already installed", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = createExternalChatDeletePlugin();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(registryRefreshMocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    const writtenConfig = firstWrittenChannelsConfig();
    expect(writtenConfig?.channels?.["external-chat"]).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("stops an active gateway channel runtime before deleting a runtime-backed account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = {
      ...createExternalChatDeletePlugin(),
      gateway: {
        startAccount: vi.fn(),
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
      method: "channels.stop",
      params: {
        channel: "external-chat",
        accountId: "default",
        exactChannel: true,
        pluginId: "@vendor/external-chat-plugin",
        pluginCandidateFingerprint: expect.any(String),
      },
      mode: "backend",
      clientName: "gateway-client",
      deviceIdentity: null,
    });
    const writtenConfig = firstWrittenChannelsConfig();
    expect(writtenConfig?.channels?.["external-chat"]).toBeUndefined();
  });

  it.each([
    [
      "an old gateway rejects ownership fields",
      "invalid channels.stop params: at root: unexpected property 'exactChannel'",
    ],
    ["the gateway has a different same-id plugin owner", "invalid channels.stop plugin owner"],
  ])("restarts and aborts before config mutation when %s", async (_case, message) => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = {
      ...createExternalChatDeletePlugin(),
      gateway: {
        startAccount: vi.fn(),
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    const compatibilityError = new Error(message) as Error & { gatewayCode: string };
    compatibilityError.name = "GatewayClientRequestError";
    compatibilityError.gatewayCode = "INVALID_REQUEST";
    gatewayMocks.callGateway
      .mockRejectedValueOnce(compatibilityError)
      .mockResolvedValueOnce({ accepted: true });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(2);
    expect(gatewayMocks.callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "gateway.restart.request",
        params: { reason: "channel remove: load external-chat" },
      }),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not restart or mutate config when a remote gateway rejects exact matching", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        gateway: {
          mode: "remote",
          remote: { url: "wss://remote-gateway.example/ws" },
        },
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = {
      ...createExternalChatDeletePlugin(),
      gateway: {
        startAccount: vi.fn(),
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    const compatibilityError = new Error(
      "invalid channels.stop params: at root: unexpected property 'exactChannel'",
    ) as Error & { gatewayCode: string };
    compatibilityError.name = "GatewayClientRequestError";
    compatibilityError.gatewayCode = "INVALID_REQUEST";
    gatewayMocks.callGateway.mockRejectedValueOnce(compatibilityError);

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(1);
    const [request] = gatewayMocks.callGateway.mock.calls[0] ?? [];
    expect(request?.params).not.toHaveProperty("pluginOrigin");
    expect(request?.params).not.toHaveProperty("pluginCandidateFingerprint");
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Remote Gateway could not verify channel plugin ownership"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not restart or mutate config for a URL-overridden gateway target", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://remote-gateway.example/ws");
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        gateway: { mode: "local" },
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
    });
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = {
      ...createExternalChatDeletePlugin(),
      gateway: {
        startAccount: vi.fn(),
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    const compatibilityError = new Error("invalid channels.stop plugin owner") as Error & {
      gatewayCode: string;
    };
    compatibilityError.name = "GatewayClientRequestError";
    compatibilityError.gatewayCode = "INVALID_REQUEST";
    gatewayMocks.callGateway.mockRejectedValueOnce(compatibilityError);

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(1);
    const [request] = gatewayMocks.callGateway.mock.calls[0] ?? [];
    expect(request?.params).not.toHaveProperty("pluginOrigin");
    expect(request?.params).not.toHaveProperty("pluginCandidateFingerprint");
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Remote Gateway could not verify channel plugin ownership"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
