// 响应归一化：抹掉每次响应都会变化的噪声（时间戳、nonce、CSRF token），
// 只留下语义差异供指纹与对比使用。

// 自动打码规则，按顺序应用
const AUTO_RULES = [
  // JSON 中形如 csrf/token/nonce 的 key，其 value 整体打码
  [/("(?:csrf(?:_token)?|xsrf(?:_token)?|_?token|nonce|sig|signature|state|ticket|session_?id|anti_?forgery)"\s*:\s*)"[^"]*"/gi, '$1"<token>"'],
  // 13 位毫秒级时间戳（1.3e12 ~ 1.9e12，覆盖当前百年）
  [/\b1[3-9]\d{11}\b/g, '<ts>'],
  // 10 位秒级时间戳（2001 ~ 2033）
  [/\b1[0-9]{9}\b/g, '<ts>'],
  // 长十六进制串（≥16 位）
  [/(?<![A-Za-z0-9])[0-9a-f]{16,}(?![A-Za-z0-9])/gi, '<token>'],
  // 高熵 Base64ish 串（≥24 位，同时含大小写与数字）
  [/(?<![A-Za-z0-9])(?=[A-Za-z0-9+/_=-]{24,})(?=[A-Za-z]*[a-z])(?=[A-Za-z]*[A-Z])(?=[A-Za-z]*\d)[A-Za-z0-9+/_=-]+(?![A-Za-z0-9])/g, '<token>'],
];

/**
 * 归一化正文。
 * @param {string} text 响应正文
 * @param {{pattern:string, flags?:string, replacement?:string}[]} ignoreRules 用户自定义忽略规则（最高优先）
 */
export function normalizeBody(text, ignoreRules = []) {
  if (text == null) return '';
  let out = String(text);
  for (const r of ignoreRules) {
    try {
      out = out.replace(new RegExp(r.pattern, r.flags || 'g'), r.replacement ?? '');
    } catch {
      // 用户正则非法时跳过该条
    }
  }
  for (const [re, rep] of AUTO_RULES) out = out.replace(re, rep);
  // 压缩空白：多空格合一、多空行合一、去首尾
  return out.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
