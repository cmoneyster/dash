import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSmsViaEjoin, isEjoinConfigured } from "../sms-ejoin";
import { sendNewInquiryAlert, sendSms } from "../sms";

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ ownerNotificationPhone: "5550100000" }],
      }),
    }),
  },
}));
vi.mock("../sms-ejoin", () => ({
  isEjoinConfigured: vi.fn().mockReturnValue(true),
  sendSmsViaEjoin: vi.fn(),
}));
vi.mock("../mail", () => ({
  sendSmsAlert: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(isEjoinConfigured).mockReturnValue(true);
});

describe("new inquiry owner SMS delivery reporting", () => {
  it("does not report a development shadow-mode send as delivered", async () => {
    vi.mocked(sendSmsViaEjoin).mockResolvedValueOnce({ port: 0, gatewayResponse: "suppressed:shadow-mode" });
    expect(await sendNewInquiryAlert({ clientName: "Test Inquiry", source: "form" })).toBe(false);
  });

  it("reports acceptance by the live gateway", async () => {
    vi.mocked(sendSmsViaEjoin).mockResolvedValueOnce({ port: 7, gatewayResponse: "accepted" });
    expect(await sendNewInquiryAlert({ clientName: "Test Inquiry", source: "form" })).toBe(true);
  });

  it("reports missing configuration and gateway errors without claiming success", async () => {
    vi.mocked(isEjoinConfigured).mockReturnValueOnce(false);
    expect(await sendSms("5550100000", "test")).toBe(false);
    vi.mocked(sendSmsViaEjoin).mockRejectedValueOnce(new Error("gateway unavailable"));
    expect(await sendNewInquiryAlert({ clientName: "Test Inquiry", source: "plan" })).toBe(false);
  });
});