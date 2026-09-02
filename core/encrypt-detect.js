// 加密函数自动探测的启发式打分（纯逻辑，无 chrome API，可单测）。
//
// 思路：拿到「候选函数名 + 它对测试输入的输出样本」后，判断输出像不像密文，
// 结合函数名是否像加密，给一个可排序的分；并提供一键生成 encryptScript 的建议。

// 名字像加密的 global 候选（用于在页面里筛选要探测的 window 函数）
export const CRYPTO_NAME_PATTERN = 'enc|crypt|rsa|sm2|sm4|aes|md5|sha1|sha256|sha384|sha512|sha|secret|sign|password|pwd|hash|encode|token';
export const CRYPTO_NAME_RE = new RegExp(CRYPTO_NAME_PATTERN, 'i');

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// 常见摘要长度 -> 类型（不可逆，但常见于密码哈希/加盐哈希）
const DIGEST_LEN = { 32: 'md5', 40: 'sha1', 56: 'sha224', 64: 'sha256', 96: 'sha384', 128: 'sha512' };

/**
 * 判断一个样本「像不像密文」。
 * @param {string} name 候选函数名
 * @param {*} sample 候选函数对输入的实际输出
 * @param {string} input 探测用输入
 * @returns {{type:string, score:number, note:string}}
 */
export function classifySample(name, sample, input) {
  const s = sample == null ? '' : String(sample);
  const n = s.length;
  const inLen = String(input).length;
  if (!s) return { type: 'empty', score: -3, note: '无输出' };
  if (s === String(input)) return { type: 'identity', score: -5, note: '输出=输入(未加密)' };
  if (HEX_RE.test(s) && n in DIGEST_LEN) return { type: 'digest', score: 8, note: '十六进制摘要 ' + DIGEST_LEN[n] };
  if (HEX_RE.test(s) && n >= 8) return { type: 'hex', score: 7, note: '十六进制串' };
  if (BASE64_RE.test(s) && n >= 8) return { type: 'base64', score: 7, note: 'Base64 串' };
  // 长度接近输入但内容明显不同 = 可能是可逆加密(置换/流加密)
  if (n >= 2 && n <= Math.max(6, inLen * 2) && !HEX_RE.test(s)) {
    return { type: 'cipher', score: 6, note: '疑似密文' };
  }
  return { type: 'plain', score: 2, note: '普通字符串' };
}

/**
 * 综合打分：输出像密文 + 名字像加密 + 是否可复现（两次输出一致）。
 * @returns {object} 含 name/type/score/note/deterministic
 */
export function scoreCandidate(name, sample, input, deterministic) {
  const c = classifySample(name, sample, input);
  let score = c.score;
  if (CRYPTO_NAME_RE.test(name)) score += 2; // 名字里带加密/哈希字样
  const det = !!deterministic;
  score += det ? 1 : -2; // 可复现利于爆破；每次不同可能带随机 nonce/IV，重放可能被拒
  return { name, type: c.type, score, note: c.note, deterministic: det, sample: sample == null ? '' : String(sample) };
}

/** 为找到的候选函数自动生成 encryptScript。ref 是完整访问路径（如 window.encrypt 或 getApp().getMD5） */
export function suggestScript(ref) {
  return `(function(){var __r=(${ref}(__VAR__)); return typeof __r==='string'?__r:(__r==null?'':JSON.stringify(__r));})()`;
}

/** JSEncrypt(RSA) 标准包装脚本：传入提取到的公钥。encrypt 失败返回 false 时给空串以免污染 payload。 */
export function suggestJsenEncryptScript(publicKey) {
  return `(function(){var e=new JSEncrypt(); e.setPublicKey(${JSON.stringify(publicKey)}); var s=e.encrypt(__VAR__); return (s===false||s==null)?'':String(s);})()`;
}

/** 判断一个字符串像不像前端 RSA 公钥（PEM / base64 DER / hex） */
export function looksLikePublicKey(s) {
  const str = String(s || '').trim();
  if (/BEGIN (RSA )?PUBLIC KEY/.test(str)) return true; // PEM 是强信号，先看（允许短）
  if (str.length < 60) return false;
  if (/^(MIGf|MIIC|MIIB|MFww|MFw|MIIE|MIIB|MIG).{20,}/.test(str)) return true; // base64 DER 开头特征
  if (/^[0-9a-fA-F]{256,}$/.test(str)) return true; // hex 公钥
  return false;
}
