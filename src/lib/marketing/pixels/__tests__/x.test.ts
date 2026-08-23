import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isXConversionsApiConfigured } from "../x";

describe("X (formerly Twitter) Conversions API configuration", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.X_PIXEL_ID;
    delete process.env.X_CONVERSIONS_API_ACCESS_TOKEN;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  describe("isXConversionsApiConfigured", () => {
    it("is false (the expected state this whole phase) when neither the token nor the pixel ID is set", () => {
      expect(isXConversionsApiConfigured()).toBe(false);
    });

    it("is false when the token is set but the pixel ID is not", () => {
      process.env.X_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      expect(isXConversionsApiConfigured()).toBe(false);
    });

    it("is false when the pixel ID is set but the token is not", () => {
      process.env.X_PIXEL_ID = "o1a2b3";
      expect(isXConversionsApiConfigured()).toBe(false);
    });

    it("is true once BOTH exist — proving the check itself works, even though nothing sets the token until §4.3", () => {
      process.env.X_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      process.env.X_PIXEL_ID = "o1a2b3";
      expect(isXConversionsApiConfigured()).toBe(true);
    });
  });
});
