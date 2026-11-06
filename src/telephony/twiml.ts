export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export function streamTwiml(wsUrl: string, params: Record<string, string>): string {
  const p = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(wsUrl)}">${p}</Stream></Connect></Response>`;
}

export function sayTwiml(text: string, hangup = true): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${escapeXml(text)}</Say>${hangup ? "<Hangup/>" : ""}</Response>`;
}

export function playTwiml(url: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escapeXml(url)}</Play><Hangup/></Response>`;
}

export const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
