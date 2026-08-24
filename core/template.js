// 模板解析与渲染：{{FUZZ}} / {{FUZZ:urlencode}}

export const FUZZ_RE = /\{\{\s*FUZZ(?::([a-z]+))?\s*\}\}/gi;

export function countFuzz(text) {
  if (!text) return 0;
  const m = String(text).match(FUZZ_RE);
  return m ? m.length : 0;
}

/** 定位模板中所有 FUZZ 占位符，应恰好返回 1 个 */
export function locateFuzz(template) {
  const positions = [];
  if (countFuzz(template.urlTemplate)) positions.push({ type: 'url' });
  for (const h of template.headers) {
    if (countFuzz(h.valueTemplate)) positions.push({ type: 'header', headerName: h.name });
  }
  if (template.bodyTemplate != null && countFuzz(template.bodyTemplate)) {
    positions.push({ type: 'body' });
  }
  return positions;
}

function renderText(text, payload, encodeByDefault) {
  return String(text).replace(FUZZ_RE, (_, mode) => {
    if (mode === 'urlencode') return encodeURIComponent(payload);
    if (mode === 'plain') return payload;
    return encodeByDefault ? encodeURIComponent(payload) : payload;
  });
}

/** 渲染完整请求（URL 中默认做 URL 编码） */
export function renderTemplate(template, payload) {
  const renderedUrl = renderText(template.urlTemplate, payload, true);
  return {
    url: renderedUrl,
    method: template.method,
    headers: template.headers.map((h) => ({ name: h.name, value: renderText(h.valueTemplate, payload, false) })),
    body: template.bodyTemplate != null ? renderText(template.bodyTemplate, payload, false) : null,
  };
}

/** 基线渲染：用原始值（标记 FUZZ 时被替换掉的原文）还原请求 */
export function renderBaseline(template) {
  return renderTemplate(template, template.fuzzOriginal ?? '');
}

/**
 * 把文本中的一段选中内容替换为 {{FUZZ}} 占位符。
 * 返回 {text, original} 或 null（无选中）。
 */
export function wrapSelection(text, start, end) {
  if (start === end) return null;
  const original = text.slice(start, end);
  return {
    text: text.slice(0, start) + '{{FUZZ}}' + text.slice(end),
    original,
  };
}
