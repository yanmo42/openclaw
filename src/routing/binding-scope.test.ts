// Binding scope tests cover canonical channel ids used by routing comparisons.
import { afterEach, describe, expect, it } from "vitest";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { setCurrentChannelOwnerMetadataForTest } from "../test-utils/plugin-metadata-snapshot.js";
import { normalizeRouteBindingChannelId } from "./binding-scope.js";

describe("normalizeRouteBindingChannelId", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
    clearCurrentPluginMetadataSnapshot();
  });

  it("preserves the canonical spelling of an enabled manifest channel", () => {
    setActivePluginRegistry(createTestRegistry());
    setCurrentChannelOwnerMetadataForTest({
      plugins: [{ pluginId: "case-chat-plugin", enabled: true }],
      channels: new Map([["CaseChat", ["case-chat-plugin"]]]),
    });

    expect(normalizeRouteBindingChannelId("casechat")).toBe("CaseChat");
  });
});
