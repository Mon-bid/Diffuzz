// 主控制器：视图编排 + 与 Service Worker 通信

import { initRequestList } from './views/request-list.js';
import { initEditor } from './views/editor.js';
import { initResults } from './views/results.js';
import { initDiffViewer } from './views/diff-viewer.js';
import { initDictManager } from './views/dict-manager.js';
import { harToTemplate, parseCurl } from '../core/har-adapter.js';
import { analyze } from '../core/diff-engine.js';

const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null, // {task, baseline, baselineRecords, records, results}
};

const editor = initEditor({ onFuzzChange: updateStartState });
const results = initResults({ onSelectRow: onSelectRow });
const diffViewer = initDiffViewer();

// 字典库：载入 = 填入 Payload 编辑框
initDictManager({
  onLoad: (content, name) => {
    document.getElementById('payloadInput').value = content;
    editor.updateEstimate();
    $('startHint').textContent = `已载入字典 "${name}"`;
  },
});

// ---------- 请求来源 ----------
const requestList = initRequestList({ onSelect: (item) => {
  const tpl = harToTemplate(item.harEntry);
  if (tpl) {
    editor.fillTemplate(tpl);
    editor.updateEstimate();
    updateStartState();
  }
}});

$('curlImport').addEventListener('click', () => {
  const tpl = parseCurl($('curlInput').value);
  if (!tpl) {
    $('startHint').textContent = 'cURL 解析失败：未找到有效的 http(s) URL';
    return;
  }
  editor.fillTemplate(tpl);
  editor.updateEstimate();
  updateStartState();
});

// ---------- FUZZ 校验与开始按钮状态 ----------
function updateStartState() {
  const n = editor.fuzzCount();
  $('start').disabled = n !== 1;
}

$('start').addEventListener('click', async () => {
  const template = editor.readTemplate();
  if (!template) {
    $('startHint').textContent = 'URL 无法解析';
    return;
  }
  const config = editor.readConfig();
  if (!config.payloads.length) {
    $('startHint').textContent = 'payload 列表为空';
    return;
  }
  // 保存设置
  chrome.storage.local.set({
    diffuzzSettings: {
      rate: $('rate').value,
      followRedirect: $('followRedirect').checked,
      allowIntranet: $('allowIntranet').checked,
      ignore: $('ignoreInput').value,
    },
  });
  const resp = await sendMsg({ type: 'task/start', template, config, allowIntranet: $('allowIntranet').checked });
  if (!resp || !resp.ok) {
    const err = (resp && resp.error) || '启动失败（Service Worker 无响应）';
    $('startHint').textContent = '✗ ' + err;
    $('startHint').classList.add('err');
    $('statusText').textContent = '启动失败: ' + err;
    $('statusbar').className = 'error';
  } else {
    $('startHint').textContent = '';
    $('startHint').classList.remove('err');
  }
});

// 恢复设置
chrome.storage.local.get('diffuzzSettings', ({ diffuzzSettings: s }) => {
  if (!s) return;
  if (s.rate) $('rate').value = s.rate;
  $('followRedirect').checked = !!s.followRedirect;
  $('allowIntranet').checked = !!s.allowIntranet;
  if (s.ignore) $('ignoreInput').value = s.ignore;
});
editor.updateEstimate();

// ---------- 原样重放 ----------
$('replay').addEventListener('click', async () => {
  const template = editor.readTemplate();
  if (!template) {
    $('startHint').textContent = 'URL 无法解析';
    return;
  }
  if (editor.fuzzCount() > 0) {
    $('startHint').textContent = '重放使用原始模板（含 {{FUZZ}} 字面值）';
  }
  $('statusText').textContent = '重放中…';
  const resp = await sendMsg({
    type: 'debug/replay',
    url: template.urlTemplate,
    method: template.method,
    headers: template.headers.map((h) => ({ name: h.name, value: h.valueTemplate })),
    body: template.bodyTemplate,
    followRedirect: $('followRedirect').checked,
  });
  if (resp && resp.ok) {
    const r = resp.record;
    $('statusText').textContent = `重放: ${r.networkError ? 'ERR ' + r.networkError : r.status + ' ' + r.statusText + ' · ' + r.bodyBytes + 'B · ' + r.timingMs + 'ms'}`;
    console.log('[Diffuzz] 重放响应', r);
  } else {
    $('statusText').textContent = '重放失败';
  }
});

// ---------- 任务控制 ----------
$('pauseBtn').addEventListener('click', () => {
  const running = state.snapshot && state.snapshot.task && /baselining|running/.test(state.snapshot.task.status);
  if (running) sendMsg({ type: 'task/pause' });
  else if (state.snapshot && state.snapshot.task && state.snapshot.task.status === 'paused') sendMsg({ type: 'task/resume' });
});
$('abortBtn').addEventListener('click', () => sendMsg({ type: 'task/abort' }));

// ---------- SW 通信 ----------
function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(r);
    });
  });
}

const port = chrome.runtime.connect({ name: 'diffuzz-panel' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'task/state') applySnapshot(msg.snapshot);
  else if (msg.type === 'task/baseline') {
    if (state.snapshot) {
      state.snapshot.baseline = msg.baseline;
      state.snapshot.baselineRecords = msg.baselineRecords;
      results.setData(state.snapshot);
    }
  } else if (msg.type === 'task/result') {
    // 增量合并 + 实时算异常分，让异常行边跑边冒出来
    if (state.snapshot) {
      const seen = new Set(state.snapshot.records.map((r) => r.seq));
      for (const r of msg.records) if (!seen.has(r.seq)) state.snapshot.records.push(r);
      if (state.snapshot.baseline) {
        state.snapshot.results = analyze(
          state.snapshot.records.filter((r) => !r.skipped),
          state.snapshot.baseline
        );
      }
      results.setData(state.snapshot);
      updateProgress();
    }
  } else if (msg.type === 'task/progress') {
    if (state.snapshot && state.snapshot.task) {
      Object.assign(state.snapshot.task.stats, msg.stats);
      renderStatus();
      updateProgress();
    }
  } else if (msg.type === 'task/done') {
    applySnapshot(msg.snapshot);
  }
});

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  if (snapshot && snapshot.task) {
    results.setData(snapshot);
  } else {
    results.setData({});
  }
  renderStatus();
  updateProgress();
}

/** 结果栏顶部的进度条与进度文字 */
function updateProgress() {
  const wrap = $('progressWrap');
  const bar = $('progressBar');
  const text = $('progressText');
  const t = state.snapshot && state.snapshot.task;
  if (!t || !t.stats || !t.stats.total) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const doneN = (t.stats.done || 0) + (t.stats.skipped || 0);
  const pct = Math.min(100, Math.round((100 * doneN) / t.stats.total));
  bar.style.width = pct + '%';
  bar.className = /done/.test(t.status) ? 'done' : t.status === 'paused' ? 'paused' : '';
  const rps = t.stats.rps || 0;
  const remain = Math.max(0, t.stats.total - doneN);
  const eta = t.status === 'running' && rps > 0 ? ` · 预计剩余 ~${fmtEta(remain / rps)}` : '';
  const errs = t.stats.errors ? ` · 错误${t.stats.errors}` : '';
  const skip = t.stats.skipped ? ` · 跳过${t.stats.skipped}` : '';
  text.textContent =
    `${statusLabel(t.status)} ${doneN}/${t.stats.total}（${pct}%）` +
    (rps && t.status === 'running' ? ` · ${rps}/s` : '') + eta + errs + skip +
    (t.error ? ` · ${t.error}` : '') +
    (t.pauseReason && t.status === 'paused' ? ` · ${t.pauseReason}` : '');
}

function statusLabel(s) {
  return { baselining: '⏳ 建基线中', running: '▶ 运行中', paused: '⏸ 已暂停', done: '✓ 完成', aborted: '⏹ 已终止', error: '✗ 出错' }[s] || s;
}

function fmtEta(sec) {
  if (sec < 60) return Math.ceil(sec) + '秒';
  if (sec < 3600) return Math.ceil(sec / 60) + '分钟';
  return (sec / 3600).toFixed(1) + '小时';
}

function renderStatus() {
  const t = state.snapshot && state.snapshot.task;
  const bar = $('statusbar');
  bar.className = '';
  if (!t) {
    $('statusText').textContent = '空闲';
    $('pauseBtn').disabled = true;
    $('abortBtn').disabled = true;
    return;
  }
  const s = t.stats;
  const eta = s.total > s.done && t.status === 'running' ? ` · 预计剩余 ~${Math.max(1, Math.round((s.total - s.done) / (t.stats.rps || 1)))}s` : '';
  $('statusText').textContent =
    `${t.status} ${s.done}/${s.total}` +
    (s.errors ? ` · 错误${s.errors}` : '') +
    (s.skipped ? ` · 跳过${s.skipped}` : '') +
    (t.stats.rps ? ` · ${t.stats.rps}/s` : '') +
    eta +
    (t.error ? ` · ${t.error}` : '') +
    (t.pauseReason && t.status === 'paused' ? ` · ${t.pauseReason}` : '');
  const active = /baselining|running/.test(t.status);
  bar.className = active ? 'running' : t.status === 'paused' ? 'paused' : t.status === 'error' ? 'error' : '';
  $('pauseBtn').disabled = !(active || t.status === 'paused');
  $('pauseBtn').textContent = t.status === 'paused' ? '继续' : '暂停';
  $('abortBtn').disabled = /done|aborted|error/.test(t.status);
}

// 结果行点击 -> 差异对比（基线记录 vs 本条）
function onSelectRow(record, diff) {
  const baselineRecord =
    state.snapshot && state.snapshot.baselineRecords && state.snapshot.baselineRecords.length
      ? state.snapshot.baselineRecords[0]
      : null;
  diffViewer.show(baselineRecord, record, diff);
}

// 面板打开时拉取当前任务状态
sendMsg({ type: 'task/state' }).then((resp) => {
  if (resp && resp.ok && resp.snapshot) applySnapshot(resp.snapshot);
});

// 全局错误兜底：面板内任何未捕获异常直接显示在状态栏，避免"无声空白"
window.addEventListener('error', (e) => {
  $('statusText').textContent = '面板异常: ' + (e.message || 'unknown');
  $('statusbar').className = 'error';
});
window.addEventListener('unhandledrejection', (e) => {
  $('statusText').textContent = '面板异常(异步): ' + ((e.reason && e.reason.message) || e.reason);
  $('statusbar').className = 'error';
});

updateStartState();
