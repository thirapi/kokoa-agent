import { describe, it, expect, vi, afterEach } from "vitest";
import { isImageAlive, keepAliveImages, youtubeSearchInnertube, youtubeSearch, BOT_USER_AGENT, youtubeMp3, extractYouTubeId, parseDuration, signMp3Url } from "../src/services/search.js";

afterEach(() => vi.unstubAllGlobals());

describe("cek gambar hidup", () => {
  it("403/429 dari Wikimedia/Flickr dianggap hidup (rate limit, bukan file mati); host lain tidak", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    expect(await isImageAlive("https://upload.wikimedia.org/a.jpg")).toBe(true);
    expect(await isImageAlive("https://live.staticflickr.com/a.jpg")).toBe(true);
    expect(await isImageAlive("https://contoh.com/a.jpg")).toBe(false);
    expect(fetch.mock.calls[0][1].headers["User-Agent"]).toBe(BOT_USER_AGENT);
  });

  it("404 = mati, 405 = hidup, URL rusak = mati", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u) => new Response(null, { status: u.includes("405") ? 405 : 404 })));
    expect(await isImageAlive("https://x.com/404.jpg")).toBe(false);
    expect(await isImageAlive("https://x.com/405.jpg")).toBe(true);
    expect(await isImageAlive("bukan url")).toBe(false);
  });

  it("maks 2 request paralel & berhenti setelah cukup", async () => {
    let inFlight = 0, peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(null, { status: 200 });
    }));
    const items = Array.from({ length: 8 }, (_, i) => ({ imageUrl: `https://x.com/${i}.jpg` }));
    const alive = await keepAliveImages(items, 4);
    expect(alive).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

const innertube = (vids) => ({
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, ...vids.map((v) => ({ videoRenderer: v }))] } },
  ] } } } },
});

describe("YouTube search (Innertube)", () => {
  it("mengurai hasil video menjadi link watch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(innertube([
      { videoId: "ZRtdQ81jPUQ", title: { runs: [{ text: "YOASOBI「アイドル」" }, { text: " Official MV" }] }, ownerText: { runs: [{ text: "YOASOBI" }] }, lengthText: { simpleText: "3:46" } },
    ])))));
    expect(await youtubeSearchInnertube("idol")).toEqual([{ title: "YOASOBI「アイドル」 Official MV", channel: "YOASOBI", duration: "3:46",
      videoId: "ZRtdQ81jPUQ", watchUrl: "https://www.youtube.com/watch?v=ZRtdQ81jPUQ" }]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).query).toBe("idol");
  });

  it("Innertube gagal sesaat -> dicoba sekali lagi", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1
      ? new Response("", { status: 429 })
      : new Response(JSON.stringify(innertube([{ videoId: "ZRtdQ81jPUQ", title: { runs: [{ text: "t" }] }, lengthText: { simpleText: "3:46" } }]))))));
    expect((await youtubeSearchInnertube("idol"))[0].videoId).toBe("ZRtdQ81jPUQ");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Innertube gagal -> cadangan Invidious", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u) => String(u).includes("youtubei")
      ? new Response("", { status: 500 })
      : new Response(JSON.stringify([{ type: "video", videoId: "abc", title: "t", author: "a" }]))));
    expect((await youtubeSearch("x"))[0].watchUrl).toBe("https://www.youtube.com/watch?v=abc");
  });
});

import { songSearch } from "../src/services/search.js";

describe("cuplikan lagu", () => {
  it("iTunes 429 (IP Cloudflare) -> cadangan Deezer dengan format sama", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u) => String(u).includes("itunes")
      ? new Response("", { status: 429 })
      : new Response(JSON.stringify({ data: [{ title: "アイドル", artist: { name: "YOASOBI" }, album: { title: "アイドル", cover_xl: "https://c/x.jpg" }, preview: "https://cdnt-preview.dzcdn.net/a.mp3", link: "https://www.deezer.com/track/1" }] }))));
    expect(await songSearch("idol")).toEqual([{ track: "アイドル", artist: "YOASOBI", album: "アイドル", previewUrl: "https://cdnt-preview.dzcdn.net/a.mp3",
      artworkUrl: "https://c/x.jpg", songUrl: "https://www.deezer.com/track/1", source: "deezer" }]);
  });

  it("dua-duanya gagal -> error jelas; tidak ketemu -> pesan ramah", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(songSearch("x")).rejects.toThrow(/Semua sumber lagu gagal: itunes: iTunes HTTP 503; deezer: Deezer HTTP 503/);
    vi.stubGlobal("fetch", vi.fn(async (u) => new Response(JSON.stringify(String(u).includes("itunes") ? { results: [] } : { data: [] }))));
    expect((await songSearch("zzz")).message).toMatch(/Tidak ada lagu/);
  });
});

describe("YouTube -> MP3", () => {
  const innertube = (items) => new Response(JSON.stringify({
    contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items.map((v) => ({ videoRenderer: v })) } }] } } } },
  }));
  const vid = (videoId, len) => ({ videoId, title: { runs: [{ text: `Lagu ${videoId}` }] }, ownerText: { runs: [{ text: "Artis" }] }, ...(len ? { lengthText: { simpleText: len } } : {}) });
  const env = { MP3_CONVERTER_URL: "https://mp3.contoh.id/", MP3_CONVERTER_SECRET: "rahasia-yang-panjang-sekali" };

  it("ambil videoId dari berbagai bentuk link", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeId("https://music.youtube.com/watch?list=x&v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeId("youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeId("yoasobi idol")).toBe(null);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("4:05")).toBe(245);
    expect(parseDuration("3.46")).toBe(226); // format Innertube hl=id
    expect(parseDuration("1.05.00")).toBe(3900);
    expect(parseDuration("LIVE")).toBe(null);
  });

  it("tanda tangan cocok dengan HMAC di server konverter", async () => {
    const { createHmac } = await import("node:crypto");
    const u = new URL(await signMp3Url("https://mp3.contoh.id/", "kunci", "dQw4w9WgXcQ"));
    const expected = createHmac("sha256", "kunci").update(`dQw4w9WgXcQ.${u.searchParams.get("exp")}`).digest("base64url");
    expect(u.origin + u.pathname).toBe("https://mp3.contoh.id/mp3");
    expect(u.searchParams.get("sig")).toBe(expected);
  });

  it("lewati live & video kepanjangan, siapkan konversi, kembalikan mp3Url", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u) => String(u).includes("youtubei")
      ? innertube([vid("LIVE0000000"), vid("MIX00000000", "1.05.00"), vid("dQw4w9WgXcQ", "3:33")])
      : new Response(JSON.stringify({ ok: true, status: "ready" }))));
    const r = await youtubeMp3("rick astley", env);
    expect(r).toMatchObject({ title: "Lagu dQw4w9WgXcQ", channel: "Artis", format: "mp3", status: "ready" });
    expect(r.mp3Url).toMatch(/^https:\/\/mp3\.contoh\.id\/mp3\?v=dQw4w9WgXcQ&exp=\d+&sig=/);
    expect(String(fetch.mock.calls[1][0])).toMatch(/\/prepare\?v=dQw4w9WgXcQ.*&wait=8$/);
  });

  it("tanpa konverter / konverter error -> error + watchUrl untuk fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u) => String(u).includes("oembed")
      ? new Response(JSON.stringify({ title: "Judul", author_name: "Kanal" }))
      : new Response(JSON.stringify({ error: "video kepanjangan" }), { status: 422 })));
    const a = await youtubeMp3("https://youtu.be/dQw4w9WgXcQ", {});
    expect(a.error).toMatch(/belum dipasang/);
    expect(a).toMatchObject({ title: "Judul", watchUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const b = await youtubeMp3("https://youtu.be/dQw4w9WgXcQ", env);
    expect(b.error).toMatch(/video kepanjangan/);
    expect(b.mp3Url).toBeUndefined();
  });
});
