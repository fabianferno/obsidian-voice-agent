// voice/http.ts - a tiny HTTP seam. The plugin passes Obsidian's requestUrl
// (no CORS limits); tests pass a fake.

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** multipart/form-data body with text fields and one file. */
export function multipart(
  fields: Record<string, string | undefined>,
  file: { name: string; field: string; type: string; data: Uint8Array },
  boundary = `----va${Math.random().toString(16).slice(2)}`,
): { body: ArrayBuffer; contentType: string } {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === '') continue;
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
