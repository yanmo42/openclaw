// Detects Gateway ownership-contract failures for canonical channel lifecycle requests.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";

export type ChannelLifecycleMethod = "channels.start" | "channels.stop" | "channels.logout";

/**
 * Host-bound provenance and restart requests are safe only for the implicit
 * local target. An explicit URL may be a tunnel to another Gateway.
 */
export function isChannelLifecycleGatewayTargetLocal(config: OpenClawConfig): boolean {
  try {
    const { urlSource } = buildGatewayConnectionDetailsWithResolvers({ config });
    return (
      urlSource === "local loopback" || urlSource === "missing gateway.remote.url (fallback local)"
    );
  } catch {
    // Invalid explicit targets are still nonlocal for host-bound ownership data.
    // The lifecycle RPC keeps ownership of reporting the underlying connection error.
    return false;
  }
}

/** Return true when a pre-ownership-contract Gateway rejected an additive request field. */
export function isChannelLifecycleOwnershipUnsupportedByGateway(
  error: unknown,
  method: ChannelLifecycleMethod,
): error is Error {
  const requestError = error as (Error & { gatewayCode?: unknown }) | undefined;
  return (
    requestError instanceof Error &&
    requestError.name === "GatewayClientRequestError" &&
    requestError.gatewayCode === "INVALID_REQUEST" &&
    requestError.message.startsWith(`invalid ${method} params:`) &&
    (requestError.message.includes("unexpected property 'exactChannel'") ||
      requestError.message.includes("unexpected property 'pluginId'") ||
      requestError.message.includes("unexpected property 'pluginOrigin'") ||
      requestError.message.includes("unexpected property 'pluginCandidateFingerprint'"))
  );
}

/** Return true when the Gateway has a different plugin owner for the canonical channel id. */
export function isChannelLifecyclePluginOwnerMismatch(
  error: unknown,
  method: ChannelLifecycleMethod,
): error is Error {
  const requestError = error as (Error & { gatewayCode?: unknown }) | undefined;
  return (
    requestError instanceof Error &&
    requestError.name === "GatewayClientRequestError" &&
    requestError.gatewayCode === "INVALID_REQUEST" &&
    requestError.message === `invalid ${method} plugin owner`
  );
}
