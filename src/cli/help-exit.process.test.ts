// Process coverage for CLI help exits and route-first fallback validation.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CHILD_PROCESS_TIMEOUT_MS = 30_000;
const LAZY_GROUP_HELP_CASES = [
  { group: "backup", usageCommand: "backup" },
  { group: "capability", usageCommand: "infer|capability" },
  { group: "channels", usageCommand: "channels" },
  { group: "clawbot", usageCommand: "clawbot" },
  { group: "daemon", usageCommand: "daemon" },
  { group: "hooks", usageCommand: "hooks" },
  { group: "infer", usageCommand: "infer|capability" },
  { group: "migrate", usageCommand: "migrate" },
  { group: "node", usageCommand: "node" },
  { group: "security", usageCommand: "security" },
  { group: "update", usageCommand: "update" },
] as const;

async function createHelpProcessFixture(config?: Record<string, unknown>) {
  const root = tempDirs.make("openclaw-help-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const tlsImportGuardPath = path.join(root, "forbid-tls-import.mjs");
  const keepAlivePath = path.join(root, "keep-alive.mjs");
  const forceExitPath = path.join(root, "force-exit.mjs");
  const unsupportedRuntimePath = path.join(root, "unsupported-runtime.mjs");
  await fs.mkdir(stateDir, { recursive: true });
  const profileConfigPath = path.join(root, ".openclaw-work", "openclaw.json");
  await fs.mkdir(path.dirname(profileConfigPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(config ?? { plugins: { entries: { "oc-path": { enabled: true } } } }),
  );
  await fs.writeFile(profileConfigPath, JSON.stringify(config ?? {}));
  await fs.writeFile(
    tlsImportGuardPath,
    `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:tls" || specifier === "tls") {
      throw new Error(\`CLI help imported TLS from \${context.parentURL ?? "unknown"}\`);
    }
    return nextResolve(specifier, context);
  },
});
`,
  );
  await fs.writeFile(keepAlivePath, "setInterval(() => {}, 60_000);\n");
  await fs.writeFile(
    forceExitPath,
    "setTimeout(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0), Number(process.env.OPENCLAW_TEST_FORCE_EXIT_MS));\n",
  );
  await fs.writeFile(
    unsupportedRuntimePath,
    'Object.defineProperty(process.versions, "node", { value: "22.0.0" });\n',
  );
  return {
    root,
    stateDir,
    configPath,
    tlsImportGuardPath,
    keepAlivePath,
    forceExitPath,
    unsupportedRuntimePath,
  };
}

async function runCliProcess(params: {
  args: string[];
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  useDefaultConfigPaths?: boolean;
  forbidTlsImport?: boolean;
  keepAlive?: boolean;
  forceExitMs?: number;
  unsupportedRuntime?: boolean;
}) {
  const fixture = await createHelpProcessFixture(params.config);
  return await execFileAsync(
    process.execPath,
    [
      ...(params.forbidTlsImport
        ? ["--import", pathToFileURL(fixture.tlsImportGuardPath).href]
        : []),
      ...(params.keepAlive ? ["--import", pathToFileURL(fixture.keepAlivePath).href] : []),
      ...(params.forceExitMs ? ["--import", pathToFileURL(fixture.forceExitPath).href] : []),
      ...(params.unsupportedRuntime
        ? ["--import", pathToFileURL(fixture.unsupportedRuntimePath).href]
        : []),
      "--import",
      "tsx",
      "src/entry.ts",
      ...params.args,
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.root,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NODE_USE_SYSTEM_CA: "1",
        OPENCLAW_CONFIG_PATH: params.useDefaultConfigPaths ? undefined : fixture.configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: params.useDefaultConfigPaths ? undefined : fixture.stateDir,
        OPENCLAW_TEST_FORCE_EXIT_MS: params.forceExitMs ? String(params.forceExitMs) : undefined,
        VITEST: undefined,
        ...params.env,
      },
      killSignal: "SIGKILL",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    },
  );
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type CliProcessFailure = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};

async function runCliProcessExpectFailure(args: string[]): Promise<CliProcessFailure> {
  try {
    await runCliProcess({ args });
  } catch (error) {
    return error as CliProcessFailure;
  }
  throw new Error(`expected CLI process failure for ${args.join(" ")}`);
}

describe("CLI help process exit", () => {
  it.each([
    { args: ["--help"], usage: "Usage: openclaw [options] [command]" },
    { args: ["path", "--help"], usage: "Usage: openclaw path [options] [command]" },
  ])("exits promptly after $args", async ({ args, usage }) => {
    const result = await runCliProcess({ args, forbidTlsImport: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(usage);
  });

  it.each(LAZY_GROUP_HELP_CASES)("exits promptly after $group --help", async (testCase) => {
    const { group, usageCommand } = testCase;
    const result = await runCliProcess({ args: [group, "--help"], keepAlive: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: openclaw ${usageCommand} [options] [command]`);
  });
});

describe("route-first CLI process rejection", () => {
  it.each([
    { name: "health", args: ["health", "--wat"], option: "--wat" },
    { name: "status", args: ["status", "--wat"], option: "--wat" },
    { name: "sessions", args: ["sessions", "--wat"], option: "--wat" },
    { name: "agents list", args: ["agents", "list", "--wat"], option: "--wat" },
    { name: "bare agents", args: ["agents", "--wat"], option: "--wat" },
  ])("rejects unknown $name options with a nonzero exit", async ({ args, option }) => {
    const failure = await runCliProcessExpectFailure(args);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(`does not recognize option "${option}"`);
  });
});

describe("JSON console style process output", () => {
  const loggingConfig = {
    logging: {
      consoleLevel: "info",
      consoleStyle: "json",
      level: "silent",
    },
  };

  it.each([
    { name: "routed", env: {} },
    { name: "Commander", env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } },
  ])("emits JSONL for $name text output", async ({ env }) => {
    const result = await runCliProcess({
      args: ["status", "--timeout", "1000"],
      config: loggingConfig,
      env,
    });

    const stdoutRecords = parseJsonLines(result.stdout);
    const stderrRecords = parseJsonLines(result.stderr);
    expect(stdoutRecords.length).toBeGreaterThan(0);
    expect([...stdoutRecords, ...stderrRecords]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "info", message: "OpenClaw status" }),
      ]),
    );
    expect([...stdoutRecords, ...stderrRecords]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("tslog: minLevel") }),
      ]),
    );
  });

  it("keeps writeJson machine output as one raw object", async () => {
    const result = await runCliProcess({
      args: ["status", "--json", "--timeout", "1000"],
      config: loggingConfig,
    });

    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toHaveProperty("gateway");
    expect(output).not.toHaveProperty("level");
    expect(output).not.toHaveProperty("message");
  });

  it("keeps typed recommendation machine output as a raw array", async () => {
    const result = await runCliProcess({
      args: ["onboard", "recommendations", "--json"],
      config: loggingConfig,
    });

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("structures invalid log-level environment warnings", async () => {
    const result = await runCliProcess({
      args: ["status", "--timeout", "1000"],
      config: loggingConfig,
      env: { OPENCLAW_LOG_LEVEL: "bogus" },
    });

    const records = [...parseJsonLines(result.stdout), ...parseJsonLines(result.stderr)];
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining('Ignoring invalid OPENCLAW_LOG_LEVEL="bogus"'),
        }),
      ]),
    );
  });

  it("structures gateway safety errors emitted before command routing", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["gateway", "--force"],
        config: {
          ...loggingConfig,
          meta: { lastTouchedVersion: "9999.1.1" },
        },
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stdout ?? "").toBe("");
    const records = parseJsonLines(failure?.stderr ?? "");
    expect(records.length).toBeGreaterThan(0);
    const messages = records
      .map((record) => (typeof record.message === "string" ? record.message : ""))
      .join("\n");
    expect(messages).toContain("written by version 9999.1.1");
    expect(messages).toContain("Refusing to force-kill gateway port listeners");
    expect(messages).not.toContain("tslog: minLevel");
  });

  it.each([
    { name: "plain", modifier: [] },
    { name: "help-shaped", modifier: ["--help"] },
    { name: "version-shaped", modifier: ["--version"] },
  ])(
    "structures $name container dispatch errors emitted before command routing",
    async ({ modifier }) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["--container", "openclaw-json-console-missing", "status", ...modifier],
          config: loggingConfig,
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      const records = parseJsonLines(failure?.stderr ?? "");
      expect(records.length).toBeGreaterThan(0);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("No running container matched"),
          }),
        ]),
      );
    },
  );

  it.each(["--help", "--version"])(
    "structures unknown-command validation with %s",
    async (modifier) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["openclaw-json-console-missing-command", modifier],
          config: loggingConfig,
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      const records = parseJsonLines(failure?.stderr ?? "");
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("Unknown command"),
          }),
        ]),
      );
    },
  );

  it("keeps pure help output on the lightweight human-formatted path", async () => {
    const result = await runCliProcess({ args: ["--help"], config: loggingConfig });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: openclaw [options] [command]");
    expect(() => parseJsonLines(result.stdout)).toThrow();
  });

  it.each([
    {
      name: "missing container value",
      args: ["--container"],
      message: "--container requires a value",
    },
    {
      name: "missing profile value",
      args: ["--profile"],
      message: "--profile requires a value",
    },
    {
      name: "container/profile conflict",
      args: ["--container", "demo", "--profile", "work", "status"],
      message: "--container cannot be combined with --profile/--dev",
    },
  ])("structures entry validation for $name", async ({ args, message }) => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({ args, config: loggingConfig });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(2);
    expect(failure?.stdout ?? "").toBe("");
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", message: expect.stringContaining(message) }),
      ]),
    );
  });

  it("uses named-profile logging style for entry validation", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--profile", "work", "--container", "demo", "status"],
        config: loggingConfig,
        useDefaultConfigPaths: true,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(2);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container cannot be combined with --profile/--dev"),
        }),
      ]),
    );
  });

  it("uses named-profile logging style when container parsing fails", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["--profile", "work", "--container"],
        config: loggingConfig,
        useDefaultConfigPaths: true,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(2);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("--container requires a value"),
        }),
      ]),
    );
  });

  it.each([
    { name: "default config", args: ["status"], useDefaultConfigPaths: false },
    { name: "named profile", args: ["--profile", "work", "status"], useDefaultConfigPaths: true },
  ])(
    "structures unsupported-runtime diagnostics from $name",
    async ({ args, useDefaultConfigPaths }) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args,
          config: loggingConfig,
          unsupportedRuntime: true,
          useDefaultConfigPaths,
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      expect(parseJsonLines(failure?.stderr ?? "")).toEqual([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("Detected: node 22.0.0"),
        }),
      ]);
    },
  );

  it("structures gateway startup tracing", async () => {
    const result = await runCliProcess({
      args: ["gateway", "status"],
      config: loggingConfig,
      env: { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
    });

    const records = parseJsonLines(result.stderr);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: expect.stringContaining("[gateway] startup trace:"),
        }),
      ]),
    );
  });

  it.each([
    { name: "routed fallback", env: {} },
    { name: "Commander", env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } },
  ])("structures $name unknown-option validation", async ({ env }) => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["status", "--definitely-invalid"],
        config: loggingConfig,
        env,
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stdout ?? "").toBe("");
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("does not recognize option"),
        }),
      ]),
    );
  });

  it("structures Commander missing-argument validation", async () => {
    let failure: CliProcessFailure | undefined;
    try {
      await runCliProcess({
        args: ["plugins", "install"],
        config: loggingConfig,
        env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
      });
    } catch (error) {
      failure = error as CliProcessFailure;
    }

    expect(failure?.code).toBe(1);
    expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("Missing required argument"),
        }),
      ]),
    );
  });

  it.each(["schema", "validate"])(
    "structures config %s Commander validation without loading mutable config",
    async (command) => {
      let failure: CliProcessFailure | undefined;
      try {
        await runCliProcess({
          args: ["config", command, "--definitely-invalid"],
          config: loggingConfig,
          env: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
        });
      } catch (error) {
        failure = error as CliProcessFailure;
      }

      expect(failure?.code).toBe(1);
      expect(failure?.stdout ?? "").toBe("");
      expect(parseJsonLines(failure?.stderr ?? "")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("does not recognize option"),
          }),
        ]),
      );
    },
  );

  it("structures required debug-proxy coverage diagnostics", async () => {
    const result = await runCliProcess({
      args: ["onboard", "recommendations", "--json"],
      config: loggingConfig,
      forceExitMs: 5_000,
      env: {
        OPENCLAW_DEBUG_PROXY_ENABLED: "1",
        OPENCLAW_DEBUG_PROXY_REQUIRE: "1",
      },
    });

    const records = [...parseJsonLines(result.stdout), ...parseJsonLines(result.stderr)];
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("debug proxy coverage"),
        }),
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("remaining gaps"),
        }),
      ]),
    );
  });
});
