// 通用工具：哈希、统计。零依赖，Node 与浏览器均可运行。

/** FNV-1a 32 位 */
export function fnv1a32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 64 位指纹：两个不同种子的 FNV-1a 32 位拼接，返回 16 位 hex */
export function hash64(str) {
  const hi = fnv1a32(str, 0x811c9dc5).toString(16).padStart(8, '0');
  const lo = fnv1a32(str, 0x9dc5811c).toString(16).padStart(8, '0');
  return hi + lo;
}

/** SHA-256 hex（SW 与 Node 18+ 均有 crypto.subtle） */
export async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 中位数绝对偏差 */
export function mad(arr, med) {
  return median(arr.map((x) => Math.abs(x - med)));
}

export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function stddev(arr, mu) {
  if (arr.length < 2) return 0;
  const m = mu ?? mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

/**
 * 鲁棒 z 分：0.6745*(x-med)/MAD。
 * MAD 为 0 时回退标准差；两者均为 0 时二值化（同=0，异=±3）。
 */
export function robustZ(x, med, madVal, mu, sd) {
  if (madVal > 0) return (0.6745 * (x - med)) / madVal;
  if (sd > 0) return (x - mu) / sd;
  return x === med ? 0 : x > med ? 3 : -3;
}

/** 简短随机 id */
export function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

/** 两个 hex 串的汉明距离 */
export function hammingHex(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
