// 浏览器加密助手：调用目标页面的 JS 加密函数，把 payload 候选值加密为密文后回填。
//
// 面板是 DevTools 页，可直接用 chrome.devtools.inspectedWindow.eval 在被检查页面
// 的【主世界】执行任意 JS —— 因此能调用页面自身的全局加密函数（含其上下文/会话密钥）。
//
// 关键点：inspectedWindow.eval **不会 await 返回的 Promise**。所以这里用一个页面内
// 的 RPC eval 桥：同步函数直接求值返回；遇到 Promise 则先存到 window.__diffuzz__ 再轮询取回。

import { buildEncryptCode } from '../../core/encrypt-expr.js';
import { CRYPTO_NAME_PATTERN, scoreCandidate, looksLikePublicKey } from '../../core/encrypt-detect.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一段 JS 在线页上下文执行；返回 {result, isException}（一次性，不 await Promise） */
export function evalInPage(code) {
  return new Promise((resolve) => {
    try {
      chrome.devtools.inspectedWindow.eval(code, (result, isException) =>
        resolve({ result, isException: !!isException })
      );
    } catch (e) {
      resolve({ result: String((e && e.message) || e), isException: true });
    }
  });
}

// 页面内的结果暂存对象（安装一次，挂在 window 上跨 eval 持久）
const INSTALL_BRIDGE = 'window.__diffuzz__ = window.__diffuzz__ || {seq: 0, store: {}}; 1;';

// 把一次求值包成「同步拿值 / Promise 落库待轮询」：
const wrapExpr = (expr) =>
  `(function(){var S=window.__diffuzz__; var id=++S.seq; var r;` +
  `try{ r=(${expr}); }catch(e){ return JSON.stringify({__err:String((e&&e.message)||e)}); }` +
  `if(r&&typeof r.then==="function"){ r.then(function(v){S.store[id]={__val:v==null?null:v};},function(e){S.store[id]={__err:String((e&&e.message)||e)};}); return JSON.stringify({__pending:id}); }` +
  `return JSON.stringify({__val:r==null?null:r});})()`;

const pollResult = `window.__diffuzz__ && window.__diffuzz__.store`; // 前缀，拼接 id 用

/**
 * 在页面里执行表达式并「等待结果」（同步直取 / 异步轮询）。
 * @returns {Promise<{isException:boolean, result:*}>}
 */
export async function evalAsyncInPage(expr) {
  await evalInPage(INSTALL_BRIDGE);
  const first = await evalInPage(wrapExpr(expr));
  if (first.isException) return { isException: true, result: String(first.result) };
  let meta;
  try {
    meta = JSON.parse(first.result);
  } catch {
    return { isException: true, result: '页面返回异常：' + String(first.result) };
  }
  if (meta.__err) return { isException: true, result: meta.__err };
  if (meta.__pending != null) {
    const id = meta.__pending;
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      const p = await evalInPage(`JSON.stringify(${pollResult}[${id}]||null)`);
      if (p.isException) continue;
      let d;
      try {
        d = JSON.parse(p.result);
      } catch {
        continue;
      }
      if (d) return d.__err ? { isException: true, result: d.__err } : { isException: false, result: d.__val };
    }
    return { isException: true, result: '加密超时（40s）' };
  }
  return { isException: false, result: meta.__val };
}

/**
 * 逐条加密 payload（走 RPC eval 桥，同步/异步都支持）。
 * @param {object} p
 * @param {string} p.script 带 __VAR__ 占位的 JS 加密表达式
 * @param {string[]} p.values 候选明文
 * @param {(i:number,n:number)=>void} [p.onProgress]
 * @returns {Promise<{out:string[], errors:{value:string,error:string}[], total:number}>}
 */
export async function encryptPayloads({ script, values, onProgress }) {
  const out = [];
  const errors = [];
  const total = values.length;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const rsp = await evalAsyncInPage(buildEncryptCode(script, v));
    if (rsp.isException) {
      errors.push({ value: v, error: String(rsp.result) });
    } else {
      const s = rsp.result == null ? '' : String(rsp.result);
      if (s) out.push(s);
      else errors.push({ value: v, error: '加密结果为空' });
    }
    if (onProgress) onProgress(i + 1, total);
  }
  return { out, errors, total };
}

// ---- 自动查找加密函数 ----
const PROBE_INPUT = 'DiffuzzProbe_123456';

/** 构造在页面里「扫描全局 + 候选函数探测 + 已知库检测」的 JS 表达式 */
export function buildDetectCode() {
  return `(function(){
    var input = ${JSON.stringify(PROBE_INPUT)};
    var out = [];
    var re = new RegExp(${JSON.stringify(CRYPTO_NAME_PATTERN)}, 'i');
    function probe(name, ref, fn){
      var a, b, err = '';
      try{ a = fn(input); }catch(e){ err = String((e && e.message) || e); }
      try{ b = fn(input); }catch(e){ b = undefined; }
      var sample = (typeof a === 'string') ? a : (typeof a === 'number' ? String(a) : '');
      var det = (sample !== '' && String(a) === String(b));
      out.push({ name: name, ref: ref, args: (fn.length || 0), sample: sample, det: det, err: err });
    }
    for (var k in window){
      try{
        var v = window[k];
        if (typeof v !== 'function') continue;
        if (!re.test(k)) continue;
        probe(k, 'window.' + k, v);
      }catch(e){}
    }
    // 也扫 getApp()/window.app 实例的方法（uni-app 等常把加密函数挂在 app 而非 window）
    try{
      var app = (typeof getApp === 'function') ? getApp() : (window.app || null);
      if (app){
        var appRef = (typeof getApp === 'function') ? 'getApp()' : 'window.app';
        for (var ka in app){
          try{
            var va = app[ka];
            if (typeof va !== 'function') continue;
            if (!re.test(ka)) continue;
            probe(ka, appRef + '.' + ka, va);
          }catch(e){}
        }
      }
    }catch(e){}
    var libs = {};
    try{ if (typeof CryptoJS !== 'undefined') libs.CryptoJS = typeof CryptoJS; }catch(e){}
    try{ if (typeof JSEncrypt !== 'undefined') libs.JSEncrypt = typeof JSEncrypt; }catch(e){}
    try{ if (typeof sm2 !== 'undefined') libs.sm2 = typeof sm2; }catch(e){}
    try{ if (typeof sm4 !== 'undefined') libs.sm4 = typeof sm4; }catch(e){}
    try{ if (typeof md5 !== 'undefined') libs.md5 = typeof md5; }catch(e){}
    // ---- 提取可能的前端 RSA 公钥（JSEncrypt 等常把 key 放在全局/文档里）----
    var keys = []; var seen = {};
    function addKey(k){ k = String(k||'').trim(); if(!k || seen[k]) return; if(k.length < 60) return; seen[k]=1; keys.push(k.slice(0,800)); }
    function looksKey(s){ s=String(s||''); return /BEGIN (RSA )?PUBLIC KEY/.test(s) || /^(MIGf|MIIC|MIIB|MFww|MFw|MIIE).{20,}/.test(s) || /^[0-9a-fA-F]{256,}/.test(s) || false; }
    for (var kk in window){
      try{
        var vv = window[kk];
        if (typeof vv === 'string' && looksKey(vv)) addKey(vv);
        else if (vv && typeof vv === 'object' && vv.publicKey && looksKey(vv.publicKey)) addKey(vv.publicKey);
      }catch(e){}
    }
    try{
      var html = document.documentElement ? document.documentElement.outerHTML : '';
      if (html.length < 4000000){
        var pem = html.match(/-----BEGIN[\\s\\S]{0,4000}?END (RSA )?PUBLIC KEY-----/g);
        if (pem) pem.forEach(addKey);
        var raw = html.match(/MIG[A-Za-z0-9+/=]{80,}/g);
        if (raw) raw.forEach(addKey);
      }
    }catch(e){}
    return JSON.stringify({ list: out, libs: libs, keys: keys });
  })()`;
}

/** 用核心打分给原始候选排序（含已知库标记） */
export function rankCandidates(rawList) {
  return (rawList || [])
    .filter((c) => c.sample !== '')
    .map((c) => ({ ...scoreCandidate(c.name, c.sample, PROBE_INPUT, c.det), ref: c.ref || 'window.' + c.name, args: c.args, err: c.err }))
    .sort((x, y) => y.score - x.score);
}

/** 在检查页面里扫描并返回候选加密函数 */
export async function detectEncryptFunctions() {
  const { result, isException } = await evalInPage(buildDetectCode());
  if (isException) return { error: String(result), candidates: [], libs: {}, keys: [] };
  let data = { list: [], libs: {}, keys: [] };
  try {
    data = JSON.parse(result) || data;
  } catch {
    data = { list: [], libs: {}, keys: [] };
  }
  return { candidates: rankCandidates(data.list), libs: data.libs || {}, keys: data.keys || [] };
}

// ---- JSEncrypt 公钥自动捕获（解决闭包/JSEncrypt 场景）----

/** 构造 JSEncrypt.prototype.encrypt 的 hook：页面真实加密时把公钥记到 window.__diffuzz_pubkey__ */
export function buildJSenHookCode() {
  return `(function(){
    var out = { hasJSEncrypt: false, hooked: false, pubkey: null };
    if (typeof window.JSEncrypt === 'function'){
      out.hasJSEncrypt = true;
      var p = window.JSEncrypt.prototype;
      if (!p.__diffuzzHooked){
        p.__diffuzzHooked = true;
        out.hooked = true;
        var orig = p.encrypt;
        p.encrypt = function(str){
          try{
            var k = null;
            try{ k = (this.getPublicKeyB64 && this.getPublicKeyB64()) || (this.getPublicKey && this.getPublicKey()) || null; }catch(e){}
            if (k) window.__diffuzz_pubkey__ = String(k);
          }catch(e){}
          return orig.apply(this, arguments);
        };
      }
    }
    try{ if (window.__diffuzz_pubkey__) out.pubkey = window.__diffuzz_pubkey__; }catch(e){}
    return JSON.stringify(out);
  })()`;
}

/** 注入 JSEncrypt hook；返回 {hasJSEncrypt, hooked, pubkey, error} */
export async function installJSenHook() {
  const rsp = await evalInPage(buildJSenHookCode());
  if (rsp.isException) return { error: String(rsp.result), hasJSEncrypt: false, hooked: false, pubkey: null };
  try {
    return JSON.parse(rsp.result);
  } catch {
    return { error: '解析失败' };
  }
}

/** 读取已捕获的公钥（须先注入 hook，再让页面触发一次真实加密，如登录） */
export async function getCapturedPubkey() {
  const rsp = await evalInPage('window.__diffuzz_pubkey__ || null');
  if (rsp.isException) return null;
  const k = rsp.result;
  return k && looksLikePublicKey(k) ? k : null;
}
