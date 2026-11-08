import { describe, it, expect } from "vitest";
import {
  getRunnerSecret, safeEqual, isAuthorizedHeader, isAuthorizedRequest,
  runnerAuthHeaders, isValidTelegramWebhook,
} from "../src/utils/auth.js";
import { SECRET, req, bearer } from "./helpers.js";

describe("runner secret auth", () => {
  it("menolak semua request bila RUNNER_SECRET tidak diset (fail-closed)", () => {
    expect(getRunnerSecret({})).toBeNull();
    expect(isAuthorizedHeader("Bearer ", {})).toBe(false);
    expect(isAuthorizedHeader("Bearer undefined", {})).toBe(false);
    expect(isAuthorizedHeader("Bearer null", { RUNNER_SECRET: null })).toBe(false);
  });

  it("menolak secret yang terlalu pendek", () => {
    expect(getRunnerSecret({ RUNNER_SECRET: "short" })).toBeNull();
    expect(isAuthorizedHeader("Bearer short", { RUNNER_SECRET: "short" })).toBe(false);
  });

  it("menolak secret lama yang dulu ter-hardcode di repo publik", () => {
    expect(isAuthorizedHeader("Bearer kokoa-runner-secret", { RUNNER_SECRET: SECRET })).toBe(false);
  });

  it("menerima hanya Bearer <secret> yang persis", () => {
    const env = { RUNNER_SECRET: SECRET };
    expect(isAuthorizedHeader(bearer(), env)).toBe(true);
    expect(isAuthorizedHeader(SECRET, env)).toBe(false);
    expect(isAuthorizedHeader(`Bearer ${SECRET}x`, env)).toBe(false);
    expect(isAuthorizedHeader(`bearer ${SECRET}`, env)).toBe(false);
    expect(isAuthorizedHeader(null, env)).toBe(false);
    expect(isAuthorizedRequest(req("/x", { auth: bearer() }), env)).toBe(true);
    expect(isAuthorizedRequest(req("/x"), env)).toBe(false);
  });

  it("safeEqual benar untuk panjang berbeda & non-string", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual(undefined, "")).toBe(false);
  });

  it("runnerAuthHeaders menambah Authorization dan gagal tanpa secret", () => {
    expect(runnerAuthHeaders({ RUNNER_SECRET: SECRET }, { "Content-Type": "application/json" }))
      .toEqual({ "Content-Type": "application/json", Authorization: bearer() });
    expect(() => runnerAuthHeaders({})).toThrow(/RUNNER_SECRET/);
  });
});

describe("telegram webhook secret", () => {
  it("dilewati bila TELEGRAM_WEBHOOK_SECRET tidak diset", () => {
    expect(isValidTelegramWebhook(req("/", { method: "POST", body: {} }), {})).toBe(true);
  });

  it("wajib cocok bila diset", () => {
    const env = { TELEGRAM_WEBHOOK_SECRET: "tg-secret" };
    const ok = req("/", { method: "POST", body: {}, headers: { "X-Telegram-Bot-Api-Secret-Token": "tg-secret" } });
    const bad = req("/", { method: "POST", body: {}, headers: { "X-Telegram-Bot-Api-Secret-Token": "nope" } });
    const none = req("/", { method: "POST", body: {} });
    expect(isValidTelegramWebhook(ok, env)).toBe(true);
    expect(isValidTelegramWebhook(bad, env)).toBe(false);
    expect(isValidTelegramWebhook(none, env)).toBe(false);
  });
});
