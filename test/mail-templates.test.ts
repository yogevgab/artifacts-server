import { describe, it, expect } from "vitest";
import { signinMail } from "../src/mail-templates";

const mail = signinMail({
  code: "418209",
  magicUrl: "https://rtfx.pro/auth/m/abc123",
  expiresMinutes: 15,
});

describe("signinMail", () => {
  it("carries the code in both html and text", () => {
    expect(mail.html).toContain("418209");
    expect(mail.text).toContain("418209");
  });

  it("carries the magic link in both html and text", () => {
    expect(mail.html).toContain("https://rtfx.pro/auth/m/abc123");
    expect(mail.text).toContain("https://rtfx.pro/auth/m/abc123");
  });

  it("states the expiry so the reader knows the code is short-lived", () => {
    expect(mail.text).toContain("15 minutes");
  });

  it("uses the product name exactly as branded", () => {
    expect(mail.subject).toContain("rtfx.pro");
    expect(mail.html).not.toContain("RTFX");
  });

  it("escapes nothing dangerous into the html", () => {
    const evil = signinMail({
      code: "<script>alert(1)</script>",
      magicUrl: "https://rtfx.pro/auth/m/x",
      expiresMinutes: 15,
    });
    expect(evil.html).not.toContain("<script>");
  });

  it("produces a text part that is not just stripped html", () => {
    expect(mail.text).not.toContain("<");
  });
});
