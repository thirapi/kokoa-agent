// Ubah contents model (Gemini format) jadi bentuk ringkas untuk disimpan ke D1:
// media -> placeholder teks, functionCall/functionResponse -> label nama saja.
export function cleanContentsForHistory(contents) {
  return (contents || []).map((c) => ({
    role: c.role,
    parts: (c.parts || [])
      .map((p) => {
        if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
        if (p.text !== undefined) return { text: p.text };
        if (p.functionCall) return { text: `[FunctionCall: ${p.functionCall.name}]` };
        if (p.functionResponse) return { text: `[FunctionResponse: ${p.functionResponse.name}]` };
        return { text: "" };
      })
      .filter((p) => p.text),
  }));
}
