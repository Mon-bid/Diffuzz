// 构造「在目标页面里执行加密函数」的表达式（纯逻辑，无 chrome API，可单测）。
//
// 用户在面板里写一段带 __VAR__ 占位的脚本，如：
//   String(window.encrypt(__VAR__))                      // 同步
//   (async()=>String(await window.encrypt(__VAR__)))()   // 异步(WebCrypto/返回Promise)
//
// 把候选明文用 JSON 字符串字面量替换占位，得到一个「求值后返回原始结果」的表达式。
// 结果可能是值或 Promise —— 由页面内的 RPC eval 桥（evalAsyncInPage）判断：
// 同步直接返回；Promise 则落库后由面板轮询取回（inspectedWindow.eval 不会 await Promise）。

export function buildEncryptCode(script, value) {
  const json = JSON.stringify(value); // 安全作为 JS 字符串/数字字面量
  const body = String(script).replace(/__VAR__/g, json);
  return `(function(){return (${body});})()`;
}
