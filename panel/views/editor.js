// ② 模板编辑器：URL/头/体编辑、FUZZ 标记、payload 管理、配置读取

import { countFuzz, wrapSelection } from '../../core/template.js';

export function initEditor({ onFuzzChange }) {
  const el = {
    method: document.getElementById('method'),
    url: document.getElementById('urlInput'),
    headers: document.getElementById('headersInput'),
    body: document.getElementById('bodyInput'),
    markFuzz: document.getElementById('markFuzz'),
    clearFuzz: document.getElementById('clearFuzz'),
    payload: document.getElementById('payloadInput'),
    rangeFrom: document.getElementById('rangeFrom'),
    rangeTo: document.getElementById('rangeTo'),
    rangeStep: document.getElementById('rangeStep'),
    rangeFill: document.getElementById('rangeFill'),
    ignore: document.getElementById('ignoreInput'),
    fuzzInfo: document.getElementById('fuzzInfo'),
    startHint: document.getElementById('startHint'),
  };

  const fields = [el.url, el.headers, el.body];
  let fuzzOriginal = null;
  // 记录最后聚焦的输入框：点按钮时焦点会离开输入框，不能依赖 document.activeElement
  let lastField = null;
  for (const f of fields) {
    f.addEventListener('focusin', () => { lastField = f; });
  }

  function fuzzCount() {
    return countFuzz(el.url.value) + countFuzz(el.headers.value) + countFuzz(el.body.value);
  }

  function updateFuzzInfo(msg) {
    const n = fuzzCount();
    const base = n === 1 ? 'FUZZ 位置已就绪' : n === 0 ? '未标记 {{FUZZ}}' : '发现 ' + n + ' 个 {{FUZZ}}，只能保留一个';
    el.fuzzInfo.textContent = (msg ? msg + '\n' : '') + base + (fuzzOriginal != null ? `（基线原始值: ${fuzzOriginal}）` : '');
    if (onFuzzChange) onFuzzChange(n);
  }

  // 阻止按钮抢占焦点，保持输入框里的选中状态
  el.markFuzz.addEventListener('mousedown', (e) => e.preventDefault());

  el.markFuzz.addEventListener('click', () => {
    const active = fields.includes(document.activeElement) ? document.activeElement : lastField;
    if (!active) {
      updateFuzzInfo('请先把光标移到 URL / 请求头 / 请求体 输入框');
      return;
    }
    const r = wrapSelection(active.value, active.selectionStart, active.selectionEnd);
    if (!r) {
      updateFuzzInfo('请先选中要变异的文字，再点"标记选中为 FUZZ"');
      return;
    }
    fuzzOriginal = r.original;
    active.value = r.text;
    updateFuzzInfo('已标记（原文已记录，将用作基线）');
  });

  el.clearFuzz.addEventListener('click', () => {
    if (fuzzOriginal != null) {
      for (const f of fields) {
        if (countFuzz(f.value)) f.value = f.value.replace(/\{\{\s*FUZZ(:[a-z]+)?\s*\}\}/gi, fuzzOriginal);
      }
    } else {
      for (const f of fields) f.value = f.value.replace(/\{\{\s*FUZZ(:[a-z]+)?\s*\}\}/gi, '');
    }
    fuzzOriginal = null;
    updateFuzzInfo();
  });

  for (const f of fields) f.addEventListener('input', () => updateFuzzInfo());

  el.rangeFill.addEventListener('click', () => {
    const from = Number(el.rangeFrom.value);
    const to = Number(el.rangeTo.value);
    const step = Math.max(1, Number(el.rangeStep.value) || 1);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      el.startHint.textContent = '区间参数不合法';
      return;
    }
    const lines = [];
    for (let v = from; v <= to && lines.length <= 2000; v += step) lines.push(String(v));
    el.payload.value = lines.join('\n');
    updateEstimate();
  });

  function parseHeaders(text) {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        if (i <= 0) return null;
        return { name: l.slice(0, i).trim(), valueTemplate: l.slice(i + 1).trim() };
      })
      .filter(Boolean);
  }

  function parseIgnoreRules(text) {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && r.pattern);
  }

  /** 从编辑器读取 RequestTemplate；host 以当前 URL 为准 */
  function readTemplate() {
    let originHost = '';
    try {
      originHost = new URL(el.url.value.trim()).host;
    } catch {
      return null;
    }
    return {
      id: 'manual',
      source: 'manual',
      method: el.method.value,
      urlTemplate: el.url.value.trim(),
      headers: parseHeaders(el.headers.value),
      bodyTemplate: el.body.value === '' ? null : el.body.value,
      originHost,
      fuzzOriginal,
    };
  }

  function fillTemplate(tpl) {
    el.method.value = tpl.method;
    el.url.value = tpl.urlTemplate;
    el.headers.value = tpl.headers.map((h) => `${h.name}: ${h.valueTemplate}`).join('\n');
    el.body.value = tpl.bodyTemplate ?? '';
    fuzzOriginal = tpl.fuzzOriginal ?? null;
    updateFuzzInfo();
  }

  /** 读取 payload 编辑框：trim / 去空 / 去重，保序 */
  function readPayloadLines() {
    const seen = new Set();
    const out = [];
    for (const line of el.payload.value.split('\n')) {
      const v = line.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  /** 用新行集回填 payload 编辑框（去空/去重，保序），并刷估算 */
  function replacePayload(lines) {
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      const v = line.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    el.payload.value = out.join('\n');
    updateEstimate();
  }

  function readConfig() {
    const payloads = readPayloadLines();
    return {
      payloads,
      ratePerSec: Number(document.getElementById('rate').value) || 2,
      followRedirect: document.getElementById('followRedirect').checked,
      baselineRuns: 3,
      timeoutMs: 15000,
      ignoreRules: parseIgnoreRules(el.ignore.value),
    };
  }

  function updateEstimate() {
    const n = el.payload.value.split('\n').filter((l) => l.trim()).length;
    const cnt = document.getElementById('payloadCount');
    if (cnt) cnt.textContent = n ? `当前 ${n} 条` : '';
    const rate = Number(document.getElementById('rate').value) || 2;
    const est = Math.round((n + 3) / rate);
    const estStr = est < 60 ? est + 's' : est < 3600 ? Math.round(est / 60) + 'min' : (est / 3600).toFixed(1) + 'h';
    let warn = '';
    if (n > 2000) warn = `（大任务：${n} 条，注意耗时与内存）`;
    if (n > 10000) warn = `（超出单任务上限 10000 条，将无法启动）`;
    el.startHint.textContent = n ? `共 ${n} 条 payload，预计 ~${estStr}（含 3 次基线）${warn}` : '';
  }
  [el.payload, document.getElementById('rate')].forEach((x) => x.addEventListener('input', updateEstimate));

  return { fillTemplate, readTemplate, readConfig, fuzzCount, updateEstimate, fields, readPayloadLines, replacePayload };
}
