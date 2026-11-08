import { describe, it, expect } from "vitest";
import { chooseRuntime, shouldRetryRemote, isSmallTalk, isRetryableSpacesError } from "../src/agent/route.js";
import { hasRepoSignal, detectScope } from "../src/agent/scope.js";

const route = (userPrompt, historyTexts = [], hasRemote = true) =>
  chooseRuntime({ hasRemote, userPrompt, historyTexts });

describe("chooseRuntime", () => {
  it("selalu Worker kalau Spaces tidak dikonfigurasi", () => {
    expect(route("clone repo thirapi/htmx dan jalankan npm test", [], false)).toBe("worker");
  });

  it("obrolan umum diproses di Worker", () => {
    expect(route("halo cocoa apa kabar hari ini?")).toBe("worker");
    expect(route("rekomendasiin lagu jepang yang enak buat belajar dong")).toBe("worker");
    expect(route("cuaca di jakarta besok gimana ya kira-kira")).toBe("worker");
  });

  it("tugas repo/kode dikirim ke Spaces", () => {
    expect(route("tolong cek bug di repo thirapi/kokoa-agent")).toBe("remote");
    expect(route("jalankan npm test di project ini")).toBe("remote");
    expect(route("init project go +htmx di thirapi/htmx")).toBe("remote");
  });

  it("pesan lanjutan ikut topik sebelumnya", () => {
    expect(route("oke lanjut", ["tolong fix bug di repo thirapi/x"])).toBe("remote");
    expect(route("oke lanjut", ["halo cocoa", "rekomendasi film dong"])).toBe("worker");
    expect(route("oke", [])).toBe("worker");
  });

  it("hanya melihat 3 pesan terakhir untuk konteks lanjutan", () => {
    const hist = ["fix bug di repo a/b", "makasih ya", "rekomendasi film", "lagu apa yang bagus"];
    expect(route("oke", hist)).toBe("worker");
  });
});

describe("shouldRetryRemote", () => {
  const timeout = (stateMutated) => Object.assign(new Error("t"), { code: "EXECUTION_TIMEOUT", stateMutated });

  it("retry hanya untuk timeout tanpa efek samping", () => {
    expect(shouldRetryRemote(timeout(false), true)).toBe(true);
    expect(shouldRetryRemote(timeout(true), true)).toBe(false);
  });

  it("tidak retry tanpa Spaces atau untuk error lain", () => {
    expect(shouldRetryRemote(timeout(false), false)).toBe(false);
    expect(shouldRetryRemote(new Error("429"), true)).toBe(false);
    expect(shouldRetryRemote(Object.assign(new Error(), { code: "EXECUTION_TIMEOUT" }), true)).toBe(false);
    expect(shouldRetryRemote(null, true)).toBe(false);
  });
});

describe("scope helpers", () => {
  it("hasRepoSignal", () => {
    expect(hasRepoSignal("ada error di kode ini")).toBe(true);
    expect(hasRepoSignal("push ke thirapi/htmx")).toBe(true);
    expect(hasRepoSignal("siang/malam enaknya makan apa")).toBe(false);
    expect(hasRepoSignal("")).toBe(false);
    expect(hasRepoSignal(null)).toBe(false);
  });

  it("detectScope tetap konsisten", () => {
    expect(detectScope("buat issue baru di github")).toBe("repo");
    expect(detectScope("oke")).toBe("continue");
    expect(detectScope("kok masih gak bisa sih", ["fix bug repo"])).toBe("continue");
    expect(detectScope("ceritain sejarah kota hiroshima dong")).toBe("general");
  });
});

describe("sapaan tidak pernah dikirim ke Spaces", () => {
  const repoHistory = ["tolong cek struktur repo thirapi/kokoa-agent"];

  it("kasus nyata: 'haii' setelah tugas repo -> Worker", () => {
    expect(route("haii", repoHistory)).toBe("worker");
  });

  it.each(["hai", "haii!", "halo", "hallo cocoa", "pagi", "makasih ya", "thanks", "wkwkwk", "selamat malam"])(
    "%s -> Worker", (t) => expect(route(t, repoHistory)).toBe("worker"));

  it("lanjutan tugas tetap ke Spaces", () => {
    expect(route("oke lanjut", repoHistory)).toBe("remote");
    expect(route("coba lagi", repoHistory)).toBe("remote");
  });

  it("isSmallTalk tidak salah tangkap kalimat tugas", () => {
    expect(isSmallTalk("halo tolong cek bug di repo thirapi/x sekarang ya")).toBe(false);
    expect(isSmallTalk("hiroshima itu di mana")).toBe(false);
  });
});

describe("isRetryableSpacesError", () => {
  it.each([
    "GEMINI_RETRY_TRIGGER: Request Timeout",
    "fetch failed",
    "Client network socket disconnected before secure TLS connection was established",
    "GEMINI_RETRY_TRIGGER: 503 - This model is currently experiencing high demand",
  ])("retryable: %s", (m) => expect(isRetryableSpacesError(m)).toBe(true));

  it.each(["GEMINI_KEY_INVALID: 400", "gak ada provider AI yang aktif", "Tool tidak terdaftar"])(
    "bukan retryable: %s", (m) => expect(isRetryableSpacesError(m)).toBe(false));
});
