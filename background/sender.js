// 请求发送：SW fetch + DNR 会话规则覆盖受限头。
//
// fetch 无法设置 Cookie/Origin/Referer 等 forbidden header，
// 这些头通过 declarativeNetRequest 的会话规则在发送瞬间覆盖，
// 规则精确匹配本次请求 URL 且仅由本扩展发起（initiatorDomains），发完立即删除。

import { sha256hex } from '../core/util.js';
import { redirectSignature } from '../core/fingerprint.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

// fetch 规范中的 forbidden header（小写）。这些走 DNR。
const FORBIDDEN_HEADERS = new Set([
  'cookie', 'cookie2', 'origin', 'referer', 'host', 'date',
  'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'via', 'expect', 'dnt',
]);

// 导入 HAR 时已剔除，这里再兜底一层：fetch 会自动算或不允许设置的头
const DROP_HEADERS = new Set(['content-length', 'accept-encoding', 'accept-charset']);

// 持久化/展示时保留的响应头白名单（不含 Cookie 值）
const RES_HEADER_WHITELIST = ['content-type', 'content-length', 'location'];

let ruleIdSeq = 1;

async function addHeaderRules(url, headers) {
  const ruleIds = [];
  const addRules = headers.map((h, i) => {
    const id = ruleIdSeq++;
    ruleIds.push(id);
    return {
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: h.name, operation: 'set', value: h.value }],
      },
      condition: {
        urlFilter: '|' + url + '|',
        resourceTypes: ['xmlhttprequest', 'other'],
        initiatorDomains: [chrome.runtime.id],
      },
    };
  });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules });
    return ruleIds;
  } catch {
    // 规则配额或匹配失败时降级：不覆盖该头
    return [];
  }
}

async function removeHeaderRules(ruleIds) {
  if (!ruleIds.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  } catch {
    // 尽力回收
  }
}

async function readCapped(res, cap) {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    return { buf: buf.byteLength > cap ? buf.slice(0, cap) : buf, capped: buf.byteLength > cap };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= cap) {
      capped = true;
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return { buf: out.buffer, capped };
}

/**
 * 发送一条请求并采集响应。
 * @returns {Promise<object>} ResponseRecord（不含 fingerprint，由调用方补）
 */
export async function sendOnce({ url, method, headers = [], body, followRedirect = true, timeoutMs = 15000 }) {
  const direct = [];
  const override = [];
  for (const h of headers) {
    const n = h.name.toLowerCase();
    if (n.startsWith(':') || DROP_HEADERS.has(n)) continue;
    if (FORBIDDEN_HEADERS.has(n)) override.push(h);
    else direct.push(h);
  }

  const initHeaders = Object.fromEntries(direct.map((h) => [h.name, h.value]));
  const init = {
    method,
    headers: initHeaders,
    credentials: 'include',
    redirect: followRedirect ? 'follow' : 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body != null && method !== 'GET' && method !== 'HEAD') init.body = body;

  const ruleIds = override.length ? await addHeaderRules(url, override) : [];
  const t0 = performance.now();
  try {
    const res = await fetch(url, init);
    const ttfb = Math.round(performance.now() - t0);

    // redirect:'manual' 时跨域 fetch 返回 opaque-redirect，读不到细节
    if (res.type === 'opaqueredirect') {
      return {
        ok: true, status: 0, statusText: 'opaque-redirect',
        finalUrl: '', redirectSig: 'opaque-redirect',
        headers: {}, bodyBytes: 0, bodyText: '', bodySha256: '',
        contentType: '', timingMs: ttfb, note: 'manual-redirect(opaque)',
      };
    }

    const { buf, capped } = await readCapped(res, MAX_BODY_BYTES);
    const totalMs = Math.round(performance.now() - t0);
    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const resHeaders = {};
    for (const name of RES_HEADER_WHITELIST) {
      const v = res.headers.get(name);
      if (v != null) resHeaders[name] = v;
    }
    const requestUrl = url;
    const finalUrl = res.url || requestUrl;
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      finalUrl,
      redirectSig: finalUrl !== requestUrl ? redirectSignature(finalUrl) : '',
      headers: resHeaders,
      bodyBytes: capped ? MAX_BODY_BYTES : buf.byteLength,
      bodyText: capped ? bodyText + '\n<截断于2MB>' : bodyText,
      bodySha256: await sha256hex(buf),
      contentType: res.headers.get('content-type') || '',
      timingMs: ttfb || totalMs,
      capped,
    };
  } catch (err) {
    return {
      ok: false,
      networkError: err && err.name === 'TimeoutError' ? 'timeout' : String((err && err.message) || err),
      status: 0, statusText: '', finalUrl: url, redirectSig: '',
      headers: {}, bodyBytes: 0, bodyText: '', bodySha256: '',
      contentType: '', timingMs: Math.round(performance.now() - t0),
    };
  } finally {
    if (ruleIds.length) removeHeaderRules(ruleIds);
  }
}
