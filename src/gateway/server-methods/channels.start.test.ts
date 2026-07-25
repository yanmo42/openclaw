/**
 * Gateway channels.start method tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  getChannelPlugin: vi.fn(),
  getLoadedChannelPluginOwnerId: vi.fn(() => "whatsapp"),
  getLoadedChannelPluginOrigin: vi.fn(() => "bundled"),
  getLoadedChannelPluginCandidateFingerprint: vi.fn(() => "gateway-candidate"),
  normalizeChannelId: vi.fn((value: string) => value),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: mocks.getChannelPlugin,
  getLoadedChannelPluginOwnerId: mocks.getLoadedChannelPluginOwnerId,
  getLoadedChannelPluginOrigin: mocks.getLoadedChannelPluginOrigin,
  getLoadedChannelPluginCandidateFingerprint: mocks.getLoadedChannelPluginCandidateFingerprint,
  normalizeChannelId: mocks.normalizeChannelId,
}));

import { channelsHandlers } from "./channels.js";

function createChannelRuntimeSnapshot(running: boolean): ChannelRuntimeSnapshot {
  return {
    channels: {
      whatsapp: {
        accountId: "default-account",
        running,
      },
    },
    channelAccounts: {
      whatsapp: {
        "default-account": {
          accountId: "default-account",
          running,
        },
      },
    },
  };
}

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.start", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      markChannelLoggedOut: vi.fn(),
      getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(true)),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

async function runChannelsStart(running: boolean) {
  const startChannel = vi.fn();
  const respond = vi.fn();

  await expectDefined(
    channelsHandlers["channels.start"],
    'channelsHandlers["channels.start"] test invariant',
  )(
    createOptions(
      { channel: "whatsapp" },
      {
        respond,
        context: {
          getRuntimeConfig: mocks.getRuntimeConfig,
          startChannel,
          getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(running)),
        } as unknown as GatewayRequestHandlerOptions["context"],
      },
    ),
  );

  return { respond, startChannel };
}

describe("channelsHandlers channels.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.getLoadedChannelPluginOwnerId.mockReturnValue("whatsapp");
    mocks.getLoadedChannelPluginOrigin.mockReturnValue("bundled");
    mocks.getLoadedChannelPluginCandidateFingerprint.mockReturnValue("gateway-candidate");
    mocks.normalizeChannelId.mockImplementation((value: string) => value);
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { startAccount: vi.fn() },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("resolves the default account and starts the channel runtime", async () => {
    const { respond, startChannel } = await runChannelsStart(true);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
    });
    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account", { manual: true });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        started: true,
      },
      undefined,
    );
  });

  it("reports started=false when the channel runtime remains stopped", async () => {
    const { respond, startChannel } = await runChannelsStart(false);

    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account", { manual: true });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        started: false,
      },
      undefined,
    );
  });

  it("does not alias-fallback an exact channel id that is absent from the running registry", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();
    mocks.normalizeChannelId.mockImplementation((value: string) =>
      value === "teams" ? "msteams" : value,
    );
    mocks.getChannelPlugin.mockImplementation((channelId: string) =>
      channelId === "msteams"
        ? {
            id: "msteams",
            gateway: { startAccount: vi.fn() },
            config: {
              defaultAccountId: () => "default-account",
              listAccountIds: () => ["default-account"],
              resolveAccount: () => ({}),
            },
          }
        : undefined,
    );

    await expectDefined(
      channelsHandlers["channels.start"],
      'channelsHandlers["channels.start"] test invariant',
    )(
      createOptions(
        { channel: "teams", exactChannel: true },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(false)),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "invalid channels.start channel",
      }),
    );
  });

  it("rejects an exact channel whose loaded plugin owner differs from the caller", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.start"],
      'channelsHandlers["channels.start"] test invariant',
    )(
      createOptions(
        {
          channel: "whatsapp",
          exactChannel: true,
          pluginId: "workspace-whatsapp",
        },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(false)),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "invalid channels.start plugin owner",
      }),
    );
  });

  it("rejects an exact same-id channel loaded from different plugin provenance", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.start"],
      'channelsHandlers["channels.start"] test invariant',
    )(
      createOptions(
        {
          channel: "whatsapp",
          exactChannel: true,
          pluginId: "whatsapp",
          pluginOrigin: "global",
        },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(false)),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "invalid channels.start plugin owner",
      }),
    );
  });

  it("rejects an exact same-id channel loaded from a different plugin candidate", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.start"],
      'channelsHandlers["channels.start"] test invariant',
    )(
      createOptions(
        {
          channel: "whatsapp",
          exactChannel: true,
          pluginId: "whatsapp",
          pluginOrigin: "bundled",
          pluginCandidateFingerprint: "cli-candidate",
        },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(false)),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "invalid channels.start plugin owner",
      }),
    );
  });

  it("preserves a mixed-case canonical id for exact lifecycle requests", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();
    const mixedCasePlugin = {
      id: "CaseChat",
      gateway: { startAccount: vi.fn() },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    };
    mocks.getChannelPlugin.mockImplementation((channelId: string) =>
      channelId === "CaseChat" ? mixedCasePlugin : undefined,
    );
    mocks.getLoadedChannelPluginOwnerId.mockReturnValue("case-chat-plugin");

    await expectDefined(
      channelsHandlers["channels.start"],
      'channelsHandlers["channels.start"] test invariant',
    )(
      createOptions(
        {
          channel: "CaseChat",
          exactChannel: true,
          pluginId: "case-chat-plugin",
        },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(() => createChannelRuntimeSnapshot(false)),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).toHaveBeenCalledWith("CaseChat", "default-account", { manual: true });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "CaseChat",
        accountId: "default-account",
        started: false,
      },
      undefined,
    );
  });
});

describe("channelsHandlers channels.stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("stops a channel account without clearing auth state", async () => {
    const stopChannel = vi.fn(async () => undefined);
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.stop"],
      'channelsHandlers["channels.stop"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {},
                channelAccounts: {
                  whatsapp: {
                    "default-account": {
                      accountId: "default-account",
                      running: false,
                    },
                  },
                },
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        stopped: true,
      },
      undefined,
    );
  });

  it("does not stop a same-id channel owned by another plugin", async () => {
    const stopChannel = vi.fn();
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.stop"],
      'channelsHandlers["channels.stop"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp", exactChannel: true, pluginId: "workspace-whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid channels.stop plugin owner" }),
    );
  });
});

describe("channelsHandlers channels.logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        channels: {
          whatsapp: {
            token: { source: "env", provider: "default", id: "WHATSAPP_TOKEN" },
          },
        },
      },
    });
  });

  it("passes the active runtime config to channel plugins", async () => {
    const runtimeConfig = {
      channels: {
        whatsapp: {
          token: "runtime-token",
        },
      },
    };
    const stopChannel = vi.fn();
    const markChannelLoggedOut = vi.fn();
    const logoutAccount = vi.fn(async ({ cfg }: { cfg: typeof runtimeConfig }) => {
      expect(cfg.channels.whatsapp.token).toBe("runtime-token");
      return { cleared: true, envToken: false, loggedOut: true };
    });
    const respond = vi.fn();
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { logoutAccount },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await expectDefined(
      channelsHandlers["channels.logout"],
      'channelsHandlers["channels.logout"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            markChannelLoggedOut,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(markChannelLoggedOut).toHaveBeenCalledWith("whatsapp", true, "default-account");
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        cleared: true,
        envToken: false,
        loggedOut: true,
      },
      undefined,
    );
  });

  it("does not log out a same-id channel owned by another plugin", async () => {
    const logoutAccount = vi.fn();
    const respond = vi.fn();
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { logoutAccount },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await expectDefined(
      channelsHandlers["channels.logout"],
      'channelsHandlers["channels.logout"] test invariant',
    )(
      createOptions(
        { channel: "whatsapp", exactChannel: true, pluginId: "workspace-whatsapp" },
        { respond },
      ),
    );

    expect(logoutAccount).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid channels.logout plugin owner" }),
    );
  });
});
