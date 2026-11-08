// Pengiriman MP3 dari konverter pribadi: diunduh Worker lalu di-upload ke Telegram
// (bukan Telegram mengambil URL — domain konverter bisa kena error 1034 di sebagian IP edge).
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramAudioUpload, TG_UPLOAD_MAX_BYTES } from "../src/services/telegram.js";
import { isMp3ConverterUrl } from "../src/services/search.js";
import { executeTool } from "../src/tools/executor.js";
import { runSelftest } from "../src/agent/selftest.js";

afterEach(() => vi.unstubAllGlobals());

const MP3 = "https://mp3.contoh.id/mp3?v=b0ZBBjViV8Y&exp=1&sig=x";
const env = { TELEGRAM_BOT_TOKEN: "0:x", MP3_CONVERTER_URL: "https://mp3.contoh.id" };

function fakeNet({ audioStatus = 200, audioBytes = 1234, tgFail = [] } = {}) {
  let tgCall = 0;
  return vi.fn(async (u, init) => {
    const url = String(u);
    if (url.startsWith("https://mp3.contoh.id/")) {
      return audioStatus === 200
        ? new Response(new Uint8Array(audioBytes), { headers: { "content-type": "audio/mpeg", "content-length": String(audioBytes) } })
        : new Response(JSON.stringify({ error: "konverter sibuk" }), { status: audioStatus });
    }
    if (url.includes("api.telegram.org")) {
      const fail = tgFail.includes(tgCall++);
      return fail
        ? new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }
    throw new Error(`fetch tak terduga: ${url} ${init?.method || ""}`);
  });
}

describe("upload MP3 ke Telegram", () => {
  it("mengunduh dari konverter lalu kirim multipart (tanpa URL ke Telegram)", async () => {
    vi.stubGlobal("fetch", fakeNet());
    const r = await sendTelegramAudioUpload("0:x", 42, MP3, "NOAH", "Separuh Aku", "");
    expect(r).toEqual({ message_id: 7 });
    const [tgUrl, init] = fetch.mock.calls[1];
    expect(tgUrl).toMatch(/\/sendAudio$/);
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("chat_id")).toBe("42");
    expect(init.body.get("performer")).toBe("NOAH");
    expect(init.body.get("audio").name).toBe("Separuh Aku.mp3");
    expect(init.body.get("audio").size).toBe(1234);
    expect(JSON.stringify([...init.body.keys()])).not.toMatch(/http/);
  });

  it("caption HTML ditolak -> ulang sebagai teks biasa", async () => {
    vi.stubGlobal("fetch", fakeNet({ tgFail: [0] }));
    await sendTelegramAudioUpload("0:x", 42, MP3, "", "t", "<b>rusak");
    expect(fetch.mock.calls[2][1].body.get("caption")).toBe("rusak");
    expect(fetch.mock.calls[2][1].body.get("parse_mode")).toBe(null);
  });

  it("konverter error / file > 50 MB -> error jelas, tidak ada upload", async () => {
    vi.stubGlobal("fetch", fakeNet({ audioStatus: 503 }));
    await expect(sendTelegramAudioUpload("0:x", 42, MP3)).rejects.toThrow(/HTTP 503.*konverter sibuk/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": String(TG_UPLOAD_MAX_BYTES + 1) } })));
    await expect(sendTelegramAudioUpload("0:x", 42, MP3)).rejects.toThrow(/melebihi batas 50 MB/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("executor: URL konverter -> upload; URL lain (cuplikan) -> tetap via URL", async () => {
    vi.stubGlobal("fetch", fakeNet());
    await executeTool("sendAudio", { audioUrl: MP3, title: "Separuh Aku", performer: "NOAH" }, env, "42");
    expect(fetch.mock.calls[1][1].body).toBeInstanceOf(FormData);

    vi.stubGlobal("fetch", fakeNet());
    await executeTool("sendAudio", { audioUrl: "https://cdnt-preview.dzcdn.net/a.mp3" }, env, "42");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).audio).toBe("https://cdnt-preview.dzcdn.net/a.mp3");
  });

  it("isMp3ConverterUrl hanya cocok dengan host konverter", () => {
    expect(isMp3ConverterUrl(MP3, env)).toBe(true);
    expect(isMp3ConverterUrl("https://mp3.contoh.id.jahat.com/mp3", env)).toBe(false);
    expect(isMp3ConverterUrl(MP3, {})).toBe(false);
    expect(isMp3ConverterUrl("bukan url", env)).toBe(false);
  });
});

describe("selftest konverter", () => {
  it("konverter mati dilaporkan tapi opsional (tidak menggagalkan selftest)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u) => (String(u).startsWith("https://mp3.contoh.id")
      ? new Response("error code: 1033", { status: 530 })
      : new Response("{}"))));
    const report = await runSelftest(env, { features: true });
    const mp3 = report.results.find((r) => r.name.startsWith("feature:mp3Converter"));
    expect(mp3).toMatchObject({ ok: false, optional: true });
    expect(mp3.error).toMatch(/HTTP 530/);
    const required = report.results.filter((r) => !r.optional);
    expect(report.ok).toBe(required.every((r) => r.ok));
  });
});
