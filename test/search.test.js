import { describe, it, expect, vi, afterEach } from "vitest";
import { isImageAlive, keepAliveImages, youtubeSearchInnertube, youtubeSearch, BOT_USER_AGENT } from "../src/services/search.js";

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
