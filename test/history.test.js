import { describe, it, expect } from "vitest";
import { cleanContentsForHistory } from "../src/utils/history.js";

describe("cleanContentsForHistory", () => {
  it("mengganti media, functionCall & functionResponse dengan placeholder", () => {
    const out = cleanContentsForHistory([
      { role: "user", parts: [{ text: "lihat ini" }, { inline_data: { mime_type: "image/jpeg", data: "AAAA" } }] },
      { role: "model", parts: [{ functionCall: { name: "webSearch", args: { q: "x" } } }] },
      { role: "function", parts: [{ functionResponse: { name: "webSearch", response: { big: "data" } } }] },
      { role: "model", parts: [{ text: "jawaban" }] },
    ]);
    expect(out).toEqual([
      { role: "user", parts: [{ text: "lihat ini" }, { text: "[Media: image/jpeg]" }] },
      { role: "model", parts: [{ text: "[FunctionCall: webSearch]" }] },
      { role: "function", parts: [{ text: "[FunctionResponse: webSearch]" }] },
      { role: "model", parts: [{ text: "jawaban" }] },
    ]);
  });

  it("membuang part kosong & tahan input jelek", () => {
    expect(cleanContentsForHistory([{ role: "model", parts: [{ text: "" }, {}] }])).toEqual([{ role: "model", parts: [] }]);
    expect(cleanContentsForHistory(null)).toEqual([]);
    expect(cleanContentsForHistory([{ role: "user" }])).toEqual([{ role: "user", parts: [] }]);
  });

  it("tidak pernah menyimpan base64 media mentah", () => {
    const out = JSON.stringify(cleanContentsForHistory([
      { role: "user", parts: [{ inline_data: { mime_type: "audio/ogg", data: "SECRETBASE64" } }] },
    ]));
    expect(out).not.toContain("SECRETBASE64");
  });
});
