import { describe, it, expect } from "vitest";
import { signinMail, viewNoticeMail, accessRequestMail } from "../src/mail-templates";

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

describe("viewNoticeMail", () => {
  const receipt = viewNoticeMail({
    viewerEmail: "dana@acme.com",
    title: "Q3 Report",
    dashboardUrl: "https://rtfx.pro/admin/artifacts/q3-report",
  });

  it("names the viewer and the artifact, in both html and text", () => {
    expect(receipt.html).toContain("dana@acme.com");
    expect(receipt.html).toContain("Q3 Report");
    expect(receipt.text).toContain("dana@acme.com");
    expect(receipt.text).toContain("Q3 Report");
  });

  it("carries the dashboard link", () => {
    expect(receipt.html).toContain("https://rtfx.pro/admin/artifacts/q3-report");
    expect(receipt.text).toContain("https://rtfx.pro/admin/artifacts/q3-report");
  });

  it("says this is a one-time notice, and how to turn it off", () => {
    expect(receipt.text.toLowerCase()).toContain("first time");
    expect(receipt.text.toLowerCase()).toContain("turn this off");
  });

  it("escapes a hostile title into the html", () => {
    const evil = viewNoticeMail({
      viewerEmail: "dana@acme.com",
      title: "<script>alert(1)</script>",
      dashboardUrl: "https://rtfx.pro/admin/artifacts/x",
    });
    expect(evil.html).not.toContain("<script>alert(1)</script>");
  });

  it("produces a text part that is not just stripped html", () => {
    expect(receipt.text).not.toContain("<");
  });
});

describe("accessRequestMail", () => {
  const request = accessRequestMail({
    requesterEmail: "stranger@example.com",
    title: "Q3 Report",
    manageUrl: "https://rtfx.pro/admin/artifacts/q3-report",
  });

  it("names the requester and the artifact", () => {
    expect(request.subject).toContain("stranger@example.com");
    expect(request.html).toContain("stranger@example.com");
    expect(request.html).toContain("Q3 Report");
    expect(request.text).toContain("stranger@example.com");
    expect(request.text).toContain("Q3 Report");
  });

  it("carries the link to grant access", () => {
    expect(request.html).toContain("https://rtfx.pro/admin/artifacts/q3-report");
    expect(request.text).toContain("https://rtfx.pro/admin/artifacts/q3-report");
  });

  it("escapes a hostile requester address into the html", () => {
    const evil = accessRequestMail({
      requesterEmail: "<script>alert(1)</script>",
      title: "Q3 Report",
      manageUrl: "https://rtfx.pro/admin/artifacts/x",
    });
    expect(evil.html).not.toContain("<script>alert(1)</script>");
  });

  it("produces a text part that is not just stripped html", () => {
    expect(request.text).not.toContain("<");
  });
});
