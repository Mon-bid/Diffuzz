// 指纹提取 + simhash64。与 chrome API 无关，纯函数。

import { hash64, hammingHex } from './util.js';

/** 文本 token 化：按行切，长行再切 3-gram shingle */
export function tokenize(text) {
  const tokens = [];
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    if (words.length <= 3) {
      tokens.push(line);
    } else {
      for (let i = 0; i + 2 < words.length; i++) {
        tokens.push(words.slice(i, i + 3).join(' '));
      }
    }
  }
  return tokens;
}

/** 标准 simhash：token 频次为权重，逐位投票，返回 16 位 hex */
export function simhash64(tokens) {
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  const votes = new Int16Array(64);
  for (const [t, w] of freq) {
    const h = BigInt('0x' + hash64(t));
    for (let b = 0; b < 64; b++) votes[b] += (h >> BigInt(b)) & 1n ? w : -w;
  }
  let out = 0n;
  for (let b = 63; b >= 0; b--) out = (out << 1n) | BigInt(votes[b] > 0 ? 1 : 0);
  return out.toString(16).padStart(16, '0');
}

export { hammingHex };

/**
 * 从一条响应构造指纹。
 * @param {{status:number, redirectSig:string, normalizedBody:string, contentType?:string}} rec
 */
export function makeFingerprint({ status, redirectSig, normalizedBody, contentType }) {
  const lenNorm = normalizedBody.length;
  return {
    status,
    redirectSig: redirectSig || '',
    lenNorm,
    lenBucket: lenNorm > 0 ? Math.floor(Math.log2(lenNorm)) : 0,
    simhash64: simhash64(tokenize(normalizedBody)),
    contentType: String(contentType || '').split(';')[0],
  };
}

/** URL -> host + path（去 query），作为跳转签名 */
export function redirectSignature(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.host + u.pathname;
  } catch {
    return '';
  }
}
