import { describe, expect, it } from "vitest";
import {
  isChannelLifecycleGatewayTargetLocal,
  isChannelLifecycleOwnershipUnsupportedByGateway,
  isChannelLifecyclePluginOwnerMismatch,
} from "./channel-lifecycle-request.js";

describe("channel lifecycle ownership request errors", () => {
  it("recognizes the additive field rejection for the requested lifecycle method", () => {
    const error = Object.assign(
      new Error("invalid channels.start params: at root: unexpected property 'exactChannel'"),
      {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      },
    );

    expect(isChannelLifecycleOwnershipUnsupportedByGateway(error, "channels.start")).toBe(true);
    expect(isChannelLifecycleOwnershipUnsupportedByGateway(error, "channels.stop")).toBe(false);
  });

  it("does not classify unrelated validation failures as version mismatches", () => {
    const error = Object.assign(
      new Error("invalid channels.start params: at root: unexpected property 'accountId'"),
      {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      },
    );

    expect(isChannelLifecycleOwnershipUnsupportedByGateway(error, "channels.start")).toBe(false);
  });

  it("recognizes pre-provenance gateways that reject the additive origin field", () => {
    const error = Object.assign(
      new Error("invalid channels.stop params: at root: unexpected property 'pluginOrigin'"),
      {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      },
    );

    expect(isChannelLifecycleOwnershipUnsupportedByGateway(error, "channels.stop")).toBe(true);
  });

  it("recognizes a loaded plugin owner mismatch for the requested lifecycle method", () => {
    const error = Object.assign(new Error("invalid channels.logout plugin owner"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });

    expect(isChannelLifecyclePluginOwnerMismatch(error, "channels.logout")).toBe(true);
    expect(isChannelLifecyclePluginOwnerMismatch(error, "channels.stop")).toBe(false);
  });

  it("classifies an invalid remote URL as nonlocal without throwing", () => {
    expect(
      isChannelLifecycleGatewayTargetLocal({
        gateway: {
          mode: "remote",
          remote: { url: "ws://remote.example.com:18789" },
        },
      }),
    ).toBe(false);
  });

  it("classifies a missing remote URL fallback as local", () => {
    expect(
      isChannelLifecycleGatewayTargetLocal({
        gateway: {
          mode: "remote",
          remote: {},
        },
      }),
    ).toBe(true);
  });
});
