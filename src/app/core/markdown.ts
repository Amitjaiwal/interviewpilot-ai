/**
 * A small, safe Markdown renderer for AI output. All text is HTML-escaped
 * first and only a fixed set of tags is produced (no links, images or raw
 * HTML), so model output can never inject markup. Angular sanitises the
 * result again when it is bound with [innerHTML].
 *
 * Supports: fenced code blocks (also unterminated ones while streaming),
 * headings, bullet and numbered lists, simple pipe tables, paragraphs,
 * inline code, bold and italics.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
  // Protect inline code spans from the emphasis rules.
  const codes: string[] = [];
  let out = escapeHtml(s).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
}

function codeBlock(lang: string, code: string): string {
  return (
    `<div class="code"><div class="code-head"><span>${escapeHtml(lang || 'code')}</span>` +
    `<span class="copy-code" role="button" title="Copy code">Copy</span></div>` +
    `<pre><code>${escapeHtml(code)}</code></pre></div>`
  );
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

function table(lines: string[]): string {
  const head = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return (
    '<table><thead><tr>' +
    head.map((h) => `<th>${inline(h)}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table>'
  );
}

function blocks(text: string): string {
  const lines = text.split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(5, heading[1].length + 2);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith('|') && /^\|?\s*:?-{2,}/.test(lines[i + 1]?.trim() ?? '')) {
      flushPara();
      flushList();
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      i--;
      html.push(table(rows));
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    if (list && /^\s{2,}/.test(line)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }

    flushList();
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return html.join('');
}

/** Remove the fence's indentation (fences nested in list items are indented). */
function dedent(code: string, indent: string): string {
  if (!indent) return code;
  return code
    .split('\n')
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()))
    .join('\n');
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const fence = /^([ \t]*)```([\w+#.-]*)[^\n]*$/gm;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(md))) {
    out.push(blocks(md.slice(last, match.index)));
    const [, indent, lang] = match;
    const start = match.index + match[0].length + 1;
    const close = /\n[ \t]*```[ \t]*(?=\n|$)/g;
    close.lastIndex = start - 1;
    const end = close.exec(md);
    if (!end) {
      // Unterminated fence (still streaming): render the rest as code.
      out.push(codeBlock(lang, dedent(md.slice(start), indent)));
      last = md.length;
      break;
    }
    out.push(codeBlock(lang, dedent(md.slice(start, end.index), indent)));
    last = Math.min(md.length, end.index + end[0].length + 1);
    fence.lastIndex = last;
  }
  if (last < md.length) out.push(blocks(md.slice(last)));
  return out.join('');
}
