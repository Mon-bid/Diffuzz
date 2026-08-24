// HAR 条目 / cURL 命令 -> RequestTemplate

import { shortId } from './util.js';

// HAR（HTTP/2）中出现的伪头与 fetch 自动管理的头，导入时剔除
const SKIP_HEADERS = new Set(['content-length', 'accept-encoding', ':authority', ':method', ':path', ':scheme', ':status']);

export function harToTemplate(entry) {
  const req = entry.request;
  const headers = (req.headers || [])
    .filter((h) => !SKIP_HEADERS.has(h.name.toLowerCase()) && !h.name.startsWith(':'))
    .map((h) => ({ name: h.name, valueTemplate: h.value }));
  let originHost = '';
  try {
    originHost = new URL(req.url).host;
  } catch {
    return null;
  }
  const postData = req.postData && typeof req.postData.text === 'string' ? req.postData.text : null;
  return {
    id: shortId(),
    source: 'har',
    method: req.method,
    urlTemplate: req.url,
    headers,
    bodyTemplate: postData,
    originHost,
    fuzzOriginal: null, // 用户标记 FUZZ 时记录被替换的原文，用于基线
  };
}

/**
 * 解析 cURL 命令（支持 -H/-X/-d/--data-raw/--data-binary/-k/--compressed/反斜杠续行）。
 */
export function parseCurl(text) {
  const cleaned = text.replace(/\\\r?\n/g, ' ').trim();
  // 分词：支持单引号、双引号与 $'...'
  const tokens = [];
  const re = /'(?:[^']|'\\'' )*'|"(?:\\.|[^"\\])*"|\$\'(?:\\.|[^'\\])*'|[^\s]+/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) tokens.push(m[0]);
  if (!tokens.length) return null;

  const unquote = (t) => {
    if (/^'/.test(t)) return t.slice(1, -1).replace(/'\\''/g, "'");
    if (/^"/.test(t)) return t.slice(1, -1).replace(/\\(.)/g, '$1');
    return t;
  };

  let url = '';
  let method = null;
  const headers = [];
  let body = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'curl') continue;
    if (t.startsWith('-')) {
      const flag = t;
      const next = () => unquote(tokens[++i]);
      if (flag === '-H' || flag === '--header') {
        const hv = next();
        const idx = hv.indexOf(':');
        if (idx > 0) headers.push({ name: hv.slice(0, idx).trim(), valueTemplate: hv.slice(idx + 1).trim() });
      } else if (flag === '-X' || flag === '--request') {
        method = next();
      } else if (flag === '-d' || flag === '--data' || flag === '--data-raw' || flag === '--data-binary' || flag === '--data-ascii') {
        body = next();
      } else if (flag.startsWith('--data-urlencode')) {
        body = next();
      } else if (flag === '--url') {
        url = next();
      }
      // -k -L --compressed -s 等无参 flag 直接忽略
    } else if (!url) {
      const ut = unquote(t);
      if (/^https?:\/\//i.test(ut)) url = ut;
    }
  }
  if (!url) return null;
  if (!method) method = body != null ? 'POST' : 'GET';

  let originHost = '';
  try {
    originHost = new URL(url).host;
  } catch {
    return null;
  }
  return {
    id: shortId(),
    source: 'curl',
    method,
    urlTemplate: url,
    headers,
    bodyTemplate: body,
    originHost,
    fuzzOriginal: null,
  };
}
