import { describe, it, expect } from "vitest";
import { chooseRuntime, shouldRetryOnSpaces } from "../src/agent/route.js";
import { hasRepoSignal, detectScope } from "../src/agent/scope.js";

const route = (userPrompt, historyTexts = [], hasSpaces = true) =>
  chooseRuntime({ hasSpaces, userPrompt, historyTexts });

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
    expect(route("tolong cek bug di repo thirapi/kokoa-agent")).toBe("spaces");
    expect(route("jalankan npm test di project ini")).toBe("spaces");
    expect(route("init project go +htmx di thirapi/htmx")).toBe("spaces");
  });

  it("pesan lanjutan ikut topik sebelumnya", () => {
    expect(route("oke lanjut", ["tolong fix bug di repo thirapi/x"])).toBe("spaces");
    expect(route("oke lanjut", ["halo cocoa", "rekomendasi film dong"])).toBe("worker");
    expect(route("oke", [])).toBe("worker");
  });

  it("hanya melihat 3 pesan terakhir untuk konteks lanjutan", () => {
    const hist = ["fix bug di repo a/b", "makasih ya", "rekomendasi film", "lagu apa yang bagus"];
    expect(route("oke", hist)).toBe("worker");
  });
});

describe("shouldRetryOnSpaces", () => {
  const timeout = (stateMutated) => Object.assign(new Error("t"), { code: "EXECUTION_TIMEOUT", stateMutated });

  it("retry hanya untuk timeout tanpa efek samping", () => {
    expect(shouldRetryOnSpaces(timeout(false), true)).toBe(true);
    expect(shouldRetryOnSpaces(timeout(true), true)).toBe(false);
  });

  it("tidak retry tanpa Spaces atau untuk error lain", () => {
    expect(shouldRetryOnSpaces(timeout(false), false)).toBe(false);
    expect(shouldRetryOnSpaces(new Error("429"), true)).toBe(false);
    expect(shouldRetryOnSpaces(Object.assign(new Error(), { code: "EXECUTION_TIMEOUT" }), true)).toBe(false);
    expect(shouldRetryOnSpaces(null, true)).toBe(false);
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
