import { describe, it, expect } from "vitest";
import { classifyMailError, isRetryable } from "../src/mail";

describe("classifyMailError", () => {
  it("treats sender/domain problems as config failures", () => {
    expect(classifyMailError("E_SENDER_NOT_VERIFIED")).toBe("config");
    expect(classifyMailError("E_SENDER_DOMAIN_NOT_AVAILABLE")).toBe("config");
  });

  it("treats suppression and validation as recipient failures", () => {
    expect(classifyMailError("E_RECIPIENT_SUPPRESSED")).toBe("recipient");
    expect(classifyMailError("E_VALIDATION_ERROR")).toBe("recipient");
    expect(classifyMailError("E_FIELD_MISSING")).toBe("recipient");
  });

  it("treats rate limits and delivery errors as transient", () => {
    expect(classifyMailError("E_RATE_LIMIT_EXCEEDED")).toBe("transient");
    expect(classifyMailError("E_DELIVERY_FAILED")).toBe("transient");
    expect(classifyMailError("E_INTERNAL_SERVER_ERROR")).toBe("transient");
  });

  it("defaults an unknown or missing code to transient", () => {
    // Unknown codes must not be treated as permanent: a new Cloudflare code
    // should degrade to "retry", never to "give up on this address".
    expect(classifyMailError("E_SOMETHING_NEW")).toBe("transient");
    expect(classifyMailError(undefined)).toBe("transient");
  });
});

describe("isRetryable", () => {
  it("is true only for transient failures", () => {
    expect(isRetryable("E_RATE_LIMIT_EXCEEDED")).toBe(true);
    expect(isRetryable("E_RECIPIENT_SUPPRESSED")).toBe(false);
    expect(isRetryable("E_SENDER_NOT_VERIFIED")).toBe(false);
  });
});
