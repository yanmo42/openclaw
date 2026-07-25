// Channels CLI tests cover channel command registration and option parsing.
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { resolveChannelsAddChannelFromArgv } from "./channels-cli-add-args.js";
import { registerChannelsCli } from "./channels-cli.js";

const listBundledPackageChannelMetadataMock = vi.hoisted(() =>
  vi.fn<() => readonly PluginPackageChannel[]>(() => []),
);
const listRawChannelPluginCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
);
const listTrustedChannelPluginCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
);
const readBestEffortConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn(() => "/test/workspace"));
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const channelsAddCommandMock = vi.hoisted(() =>
  vi.fn<typeof import("../commands/channels.js").channelsAddCommand>(async () => undefined),
);
const runtimeMock = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: listBundledPackageChannelMetadataMock,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: listRawChannelPluginCatalogEntriesMock,
}));

vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: listTrustedChannelPluginCatalogEntriesMock,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: readBestEffortConfigMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../commands/channels.js", () => ({
  channelsAddCommand: channelsAddCommandMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

function getChannelAddOptionFlags(program: Command): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const add = channels?.commands.find((command) => command.name() === "add");
  return add?.options.map((option) => option.flags) ?? [];
}

async function runChannelsAddCli(args: string[]) {
  const program = new Command().name("openclaw");
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
  return program;
}

describe("registerChannelsCli", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("registers an exact trusted workspace channel's options before a bundled alias", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "msteams",
        aliases: ["teams"],
        setup: {
          fields: [
            {
              key: "appId",
              kind: "string",
              cli: { flags: "--app-id <id>", description: "Microsoft Teams app id" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "teams",
        pluginId: "teams-workspace",
        origin: "workspace",
        channel: {
          id: "teams",
          label: "Workspace Teams",
          setup: {
            fields: [
              {
                key: "workspaceKey",
                kind: "string",
                cli: { flags: "--workspace-key <key>", description: "Workspace channel key" },
              },
            ],
          },
        },
        meta: {
          id: "teams",
          label: "Workspace Teams",
          selectionLabel: "Workspace Teams",
          docsPath: "/channels/teams",
          blurb: "Workspace channel.",
        },
        install: { npmSpec: "teams-workspace", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--channel", "teams", "--workspace-key", "secret"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "teams", workspaceKey: "secret" }),
      runtimeMock,
      { hasFlags: true },
    );
    expect(listTrustedChannelPluginCatalogEntriesMock).toHaveBeenCalledOnce();
  });

  it("registers a trusted workspace shadow's options before the same bundled id", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "botToken",
              kind: "string",
              cli: { flags: "--bot-token <token>", description: "Bundled bot token" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "telegram",
        pluginId: "telegram-workspace",
        origin: "workspace",
        channel: {
          id: "telegram",
          label: "Workspace Telegram",
          setup: {
            fields: [
              {
                key: "workspaceToken",
                kind: "string",
                cli: { flags: "--workspace-token <token>", description: "Workspace token" },
              },
            ],
          },
        },
        meta: {
          id: "telegram",
          label: "Workspace Telegram",
          selectionLabel: "Workspace Telegram",
          docsPath: "/channels/telegram-workspace",
          blurb: "Workspace channel shadow.",
        },
        install: { npmSpec: "telegram-workspace", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "telegram",
      "--workspace-token",
      "secret",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", workspaceToken: "secret" }),
      runtimeMock,
      { hasFlags: true },
    );
    expect(listTrustedChannelPluginCatalogEntriesMock).toHaveBeenCalledOnce();
  });

  it("keeps bundled options ahead of a trusted global plugin with the same channel id", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "botToken",
              kind: "string",
              cli: { flags: "--bot-token <token>", description: "Bundled bot token" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "telegram",
        pluginId: "telegram-global",
        origin: "global",
        channel: {
          id: "telegram",
          label: "Global Telegram",
          setup: {
            fields: [
              {
                key: "globalToken",
                kind: "string",
                cli: { flags: "--global-token <token>", description: "Global token" },
              },
            ],
          },
        },
        meta: {
          id: "telegram",
          label: "Global Telegram",
          selectionLabel: "Global Telegram",
          docsPath: "/channels/telegram-global",
          blurb: "Global channel collision.",
        },
        install: { npmSpec: "telegram-global" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--channel", "telegram", "--bot-token", "secret"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", botToken: "secret" }),
      runtimeMock,
      { hasFlags: true },
    );
    expect(listTrustedChannelPluginCatalogEntriesMock).toHaveBeenCalledOnce();
  });

  it("keeps bundled options ahead of a trusted workspace duplicate with the same plugin id", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "botToken",
              kind: "string",
              cli: { flags: "--bot-token <token>", description: "Bundled bot token" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "telegram",
        pluginId: "telegram",
        origin: "workspace",
        preferredRuntimeOwner: false,
        channel: {
          id: "telegram",
          label: "Workspace Telegram Duplicate",
          setup: {
            fields: [
              {
                key: "workspaceToken",
                kind: "string",
                cli: { flags: "--workspace-token <token>", description: "Workspace token" },
              },
            ],
          },
        },
        meta: {
          id: "telegram",
          label: "Workspace Telegram Duplicate",
          selectionLabel: "Workspace Telegram Duplicate",
          docsPath: "/channels/telegram-workspace",
          blurb: "Workspace duplicate of the bundled plugin.",
        },
        install: { npmSpec: "telegram", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--channel", "telegram", "--bot-token", "secret"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", botToken: "secret" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("uses a recorded global override's options ahead of the bundled plugin", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "botToken",
              kind: "string",
              cli: { flags: "--bot-token <token>", description: "Bundled bot token" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "telegram",
        pluginId: "telegram",
        origin: "global",
        preferredRuntimeOwner: true,
        channel: {
          id: "telegram",
          label: "Installed Telegram Override",
          setup: {
            fields: [
              {
                key: "globalToken",
                kind: "string",
                cli: { flags: "--global-token <token>", description: "Global token" },
              },
            ],
          },
        },
        meta: {
          id: "telegram",
          label: "Installed Telegram Override",
          selectionLabel: "Installed Telegram Override",
          docsPath: "/channels/telegram-global",
          blurb: "Recorded global override.",
        },
        install: { npmSpec: "telegram-global" },
      },
    ]);

    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "telegram",
      "--global-token",
      "secret",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", globalToken: "secret" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("discovers trusted workspace options before a positional channel", async () => {
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValue([
      {
        id: "teams",
        pluginId: "teams-workspace",
        origin: "workspace",
        channel: {
          id: "teams",
          label: "Workspace Teams",
          setup: {
            fields: [
              {
                key: "workspaceKey",
                kind: "string",
                cli: { flags: "--workspace-key <key>", description: "Workspace channel key" },
              },
            ],
          },
        },
        meta: {
          id: "teams",
          label: "Workspace Teams",
          selectionLabel: "Workspace Teams",
          docsPath: "/channels/teams",
          blurb: "Workspace channel.",
        },
        install: { npmSpec: "teams-workspace", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--workspace-key", "secret", "teams"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "teams", workspaceKey: "secret" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("carries an exact trusted workspace channel's legacy coercion contract into execution", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "msteams",
        aliases: ["teams"],
        setup: {
          fields: [
            {
              key: "appId",
              kind: "string",
              cli: { flags: "--app-id <id>", description: "Microsoft Teams app id" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "teams",
        pluginId: "teams-workspace",
        origin: "workspace",
        channel: {
          id: "teams",
          label: "Workspace Teams",
          cliAddOptions: [
            {
              flags: "--room-ids <ids>",
              description: "Workspace room ids",
              valueType: "list",
            },
          ],
        },
        meta: {
          id: "teams",
          label: "Workspace Teams",
          selectionLabel: "Workspace Teams",
          docsPath: "/channels/teams",
          blurb: "Workspace channel.",
        },
        install: { npmSpec: "teams-workspace", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--channel", "teams", "--room-ids", "one,two"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "teams", roomIds: "one,two" }),
      runtimeMock,
      expect.objectContaining({
        hasFlags: true,
        setupValueMetadataByAttributeName: expect.any(Map),
      }),
    );
  });

  it("carries an empty trusted legacy coercion contract into execution", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "teams",
        cliAddOptions: [
          {
            flags: "--room-ids <ids>",
            description: "Bundled room ids",
            valueType: "list",
          },
        ],
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "teams",
        pluginId: "teams-workspace",
        origin: "workspace",
        channel: {
          id: "teams",
          label: "Workspace Teams",
          cliAddOptions: [
            {
              flags: "--room-ids <ids>",
              description: "Opaque workspace room id",
            },
          ],
        },
        meta: {
          id: "teams",
          label: "Workspace Teams",
          selectionLabel: "Workspace Teams",
          docsPath: "/channels/teams",
          blurb: "Workspace channel.",
        },
        install: { npmSpec: "teams-workspace", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--channel", "teams", "--room-ids", "one,two"]);

    const commandParams = channelsAddCommandMock.mock.calls[0]?.[2];
    expect(commandParams?.setupValueMetadataByAttributeName).toEqual(new Map());
  });

  it("carries an empty trusted fallback coercion contract into execution", async () => {
    listRawChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "teams",
        pluginId: "teams-global-shadow",
        origin: "global",
        channel: {
          id: "teams",
          label: "Untrusted Teams Shadow",
          cliAddOptions: [
            {
              flags: "--room-ids <ids>",
              description: "Shadow room ids",
              valueType: "list",
            },
          ],
        },
        meta: {
          id: "teams",
          label: "Untrusted Teams Shadow",
          selectionLabel: "Untrusted Teams Shadow",
          docsPath: "/channels/teams",
          blurb: "Untrusted global shadow.",
        },
        install: { npmSpec: "teams-global-shadow" },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "teams",
        pluginId: "teams-official",
        channel: {
          id: "teams",
          label: "Official Teams",
          cliAddOptions: [
            {
              flags: "--room-ids <ids>",
              description: "Opaque official room id",
            },
          ],
        },
        meta: {
          id: "teams",
          label: "Official Teams",
          selectionLabel: "Official Teams",
          docsPath: "/channels/teams",
          blurb: "Trusted official fallback.",
        },
        install: { npmSpec: "teams-official" },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--channel", "teams", "--room-ids", "one,two"]);

    const commandParams = channelsAddCommandMock.mock.calls[0]?.[2];
    expect(commandParams?.setupValueMetadataByAttributeName).toEqual(new Map());
  });

  it("prefers modern contract options when a channel also publishes cliAddOptions", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValue([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
        cliAddOptions: [{ flags: "--legacy-token <token>", description: "Retained legacy switch" }],
      },
    ]);

    const program = new Command().name("openclaw");
    const argv = ["channels", "add", "telegram", "--token", "test-token"];
    await registerChannelsCli(program, ["node", "openclaw", ...argv]);
    const flags = getChannelAddOptionFlags(program);
    expect(flags).toContain("--token <token>");
    expect(flags).not.toContain("--legacy-token <token>");

    await program.parseAsync(argv, { from: "user" });
    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", token: "test-token" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("resolves a positional channel after a value-taking channel option", async () => {
    const metadata: PluginPackageChannel[] = [
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
    ];
    listBundledPackageChannelMetadataMock
      .mockReturnValueOnce(metadata)
      .mockReturnValueOnce(metadata);

    await runChannelsAddCli(["channels", "add", "--token", "tok", "telegram"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", token: "tok" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("resolves a positional channel after a boolean channel option", async () => {
    const metadata: PluginPackageChannel[] = [
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "useEnv",
              kind: "boolean",
              cli: { flags: "--use-env", description: "Use Telegram environment credentials" },
            },
          ],
        },
      },
    ];
    listBundledPackageChannelMetadataMock
      .mockReturnValueOnce(metadata)
      .mockReturnValueOnce(metadata);

    await runChannelsAddCli(["channels", "add", "--use-env", "telegram"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", useEnv: true }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("keeps an all-channel-unknown flag before a positional channel ambiguous", async () => {
    await expect(
      resolveChannelsAddChannelFromArgv([
        "node",
        "openclaw",
        "channels",
        "add",
        "--unknown-option",
        "value",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
  });

  it("keeps conflicting all-channel flag arities before a positional channel ambiguous", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "chat-a",
        setup: {
          fields: [
            {
              key: "mode",
              kind: "string",
              cli: { flags: "--mode <mode>", description: "Chat A mode" },
            },
          ],
        },
      },
      {
        id: "chat-b",
        setup: {
          fields: [
            {
              key: "mode",
              kind: "boolean",
              cli: { flags: "--mode", description: "Enable Chat B mode" },
            },
          ],
        },
      },
    ]);

    await expect(
      resolveChannelsAddChannelFromArgv([
        "node",
        "openclaw",
        "channels",
        "add",
        "--mode",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
  });

  it("includes trusted catalog arity conflicts before consuming positional values", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "chat-a",
        setup: {
          fields: [
            {
              key: "mode",
              kind: "string",
              cli: { flags: "--mode <mode>", description: "Bundled mode" },
            },
          ],
        },
      },
    ]);
    listTrustedChannelPluginCatalogEntriesMock.mockReturnValueOnce([
      {
        id: "teams",
        pluginId: "teams-workspace",
        origin: "workspace",
        channel: {
          id: "teams",
          label: "Workspace Teams",
          setup: {
            fields: [
              {
                key: "mode",
                kind: "boolean",
                cli: { flags: "--mode", description: "Workspace mode" },
              },
            ],
          },
        },
        meta: {
          id: "teams",
          label: "Workspace Teams",
          selectionLabel: "Workspace Teams",
          docsPath: "/channels/teams",
          blurb: "Workspace channel.",
        },
        install: { npmSpec: "teams-workspace", localPath: ".", defaultChoice: "local" },
      },
    ]);

    await expect(
      resolveChannelsAddChannelFromArgv([
        "node",
        "openclaw",
        "channels",
        "add",
        "--mode",
        "teams",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
    expect(listTrustedChannelPluginCatalogEntriesMock).toHaveBeenCalledOnce();
  });

  it("finds a positional channel after shared option-value pairs", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
    ]);

    await runChannelsAddCli(["channels", "add", "--account", "work", "telegram", "--token", "tok"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", account: "work", token: "tok" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("lets an explicit channel override the positional channel during option registration", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "telegram",
        setup: {
          fields: [
            {
              key: "token",
              kind: "string",
              cli: { flags: "--token <token>", description: "Telegram bot token" },
            },
          ],
        },
      },
      {
        id: "signal",
        setup: {
          fields: [
            {
              key: "signalNumber",
              kind: "string",
              cli: { flags: "--signal-number <e164>", description: "Signal account number" },
            },
          ],
        },
      },
    ]);

    await runChannelsAddCli([
      "channels",
      "add",
      "telegram",
      "--channel",
      "signal",
      "--signal-number",
      "+15555550123",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "signal", signalNumber: "+15555550123" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("treats plugin-provided config flags as direct automation inputs", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "matrix",
        cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
      },
    ]);

    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "matrix",
      "--homeserver",
      "https://matrix.example.org",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "matrix", homeserver: "https://matrix.example.org" }),
      runtimeMock,
      { hasFlags: true },
    );
  });
});
