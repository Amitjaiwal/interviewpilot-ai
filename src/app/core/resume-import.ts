/**
 * Extracts plain text from a resume the user picks with a file input. Runs
 * entirely in the renderer: the file never leaves the machine and no
 * privileged main-process access is needed.
 */

export const RESUME_ACCEPT = '.txt,.md,.pdf,.docx';
const MAX_BYTES = 10 * 1024 * 1024;

export async function extractResumeText(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error('The file is larger than 10 MB.');
  const name = file.name.toLowerCase();
  let text: string;
  if (name.endsWith('.pdf')) text = await pdfText(file);
  else if (name.endsWith('.docx')) text = await docxText(await file.arrayBuffer());
  else if (name.endsWith('.txt') || name.endsWith('.md')) text = await file.text();
  else throw new Error('Unsupported file type. Use PDF, DOCX, TXT or MD.');

  text = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('No text found. Scanned (image-only) PDFs are not supported; paste the text instead.');
  return text;
}

async function pdfText(file: File): Promise<string> {
  // Loaded on demand: pdf.js is large and only needed here.
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n\n');
}

/** A .docx is a zip; the body text lives in word/document.xml. */
async function docxText(buf: ArrayBuffer): Promise<string> {
  const xml = await readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('This does not look like a valid .docx file.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W, 'p'));
  return paragraphs
    .map((p) =>
      Array.from(p.getElementsByTagNameNS(W, '*'))
        .map((n) => (n.localName === 't' ? n.textContent : n.localName === 'tab' ? '\t' : n.localName === 'br' ? '\n' : ''))
        .join(''),
    )
    .join('\n');
}

/** Minimal zip reader: finds one entry via the central directory and inflates it. */
async function readZipEntry(buf: ArrayBuffer, wanted: string): Promise<string | null> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // End of central directory record: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < entries && p + 46 <= buf.byteLength; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) return decoder.decode(data);
      if (method !== 8) return null;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
