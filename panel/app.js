// 主控制器：视图编排 + 与 Service Worker 通信

import { initRequestList } from './views/request-list.js';
import { initEditor } from './views/editor.js';
import { initResults } from './views/results.js';
import { initDiffViewer } from './views/diff-viewer.js';
import { initDictManager } from './views/dict-manager.js';
import { harToTemplate, parseCurl } from '../core/har-adapter.js';
import { analyze } from '../core/diff-engine.js';
import { renderBaseline } from '../core/template.js';
import { normalizeBody } from '../core/normalize.js';
import { makeFingerprint } from '../core/fingerprint.js';
import { TaskRunner } from '../background/task-runner.js';
import { sendOnce } from '../background/sender.js';
import { encryptPayloads, detectEncryptFunctions, installJSenHook, getCapturedPubkey } from './views/encrypt-helper.js';
import { suggestScript, suggestJsenEncryptScript } from '../core/encrypt-detect.js';

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
  runner.allowIntranet = $('allowIntranet').checked;
  const resp = await runner.start({ template, config });
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

// 重放时剥掉的缓存条件头：带走它们会让服务器校验缓存直接回 304（0B 空正文），
// 拿不到完整响应；剥掉后才能取得 200 完整正文。
const REPLAY_DROP_HEADERS = new Set([
  'cookie', 'content-length', 'accept-encoding',
  'if-none-match', 'if-modified-since', 'if-match',
  'if-unmodified-since', 'if-range', 'range',
]);

/** 从捕获的 HAR 条目构造「尽量原样」的请求。剔除 Cookie（改用浏览器本地登录态 + credentials:include），其余含 origin/referer 交由 DNR 覆盖。 */
function buildRawRequest(harEntry) {
  const req = harEntry && harEntry.request;
  if (!req) return null;
  const headers = [];
  for (const h of req.headers || []) {
    const n = (h.name || '').toLowerCase();
    if (n.startsWith(':') || REPLAY_DROP_HEADERS.has(n)) continue;
    headers.push({ name: h.name, value: h.value });
  }
  const body = req.postData && typeof req.postData.text === 'string' ? req.postData.text : null;
  return { url: req.url, method: req.method, headers, body, followRedirect: $('followRedirect').checked };
}

/** 给重放响应补指纹，供查看器直接展示 */
function decorateReplay(r) {
  const fingerprint = makeFingerprint({
    status: r.status,
    redirectSig: r.redirectSig,
    normalizedBody: normalizeBody(r.bodyText || '', []),
    contentType: r.contentType,
  });
  return { seq: 'R', payload: '(replay)', ...r, fingerprint };
}

$('replay').addEventListener('click', async () => {
  // 优先：重放「捕获列表」里当前选中的那一条原始请求；无选中才回退为模板基线（还原 fuzzOriginal，不含 {{FUZZ}} 字面值）。
  const item = requestList.getSelected();
  let r;
  if (item && item.harEntry) {
    const raw = buildRawRequest(item.harEntry);
    if (!raw) {
      $('startHint').textContent = '该条无有效请求内容';
      return;
    }
    $('statusText').textContent = '重放中…(捕获到的原始请求)';
    r = await sendOnce(raw);
  } else {
    const template = editor.readTemplate();
    if (!template) {
      $('startHint').textContent = 'URL 无法解析';
      return;
    }
    $('statusText').textContent = '重放中…(模板基线)';
    r = await sendOnce({ ...renderBaseline(template), followRedirect: $('followRedirect').checked });
  }
  diffViewer.show(null, decorateReplay(r), null);
  $('statusText').textContent = `重放: ${r.networkError ? 'ERR ' + r.networkError : r.status + ' ' + r.statusText + ' · ' + r.bodyBytes + 'B · ' + r.timingMs + 'ms'}`;
  console.log('[Diffuzz] 重放响应', r);
});

// ---------- 浏览器加密：用页面 JS 加密整个 payload 列表 ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('encryptDetect').addEventListener('click', async () => {
  const box = $('encryptCandidates');
  box.innerHTML = '扫描中…';
  const { candidates, libs, keys, error } = await detectEncryptFunctions();
  if (error) {
    box.innerHTML = '扫描失败：' + esc(error);
    return;
  }
  const libKeys = Object.keys(libs);
  const libNote = libKeys.length
    ? '检测到加密库：' + esc(libKeys.join(', ')) + (libs.JSEncrypt ? '（JSEncrypt/RSA）' : '') + '<br>'
    : '';

  // 有 JSEncrypt（或 sm2）且找到公钥 -> 一键生成标准包装脚本（比全局扫描更常用）
  const wantLib = libs.JSEncrypt || libs.sm2;
  const keyNote = keys.length
    ? `<div class="cand"><button class="btn ghost" data-gen-rsa="1">一键生成 ${esc(libs.JSEncrypt ? 'JSEncrypt' : 'sm2')} 脚本（用提取到的公钥）</button></div>` +
      `<div class="hint">已提取 ${keys.length} 个公钥，最可能的一个：${esc(String(keys[0]).slice(0, 50))}…</div>`
    : wantLib
      ? `<div class="cand"><button class="btn ghost" data-hook-jsenc="1">注入 JSEncrypt 钩子，捕获公钥</button></div>` +
        `<div class="hint">检测到 JSEncrypt 但没找到公钥。点上面按钮注入钩子后，请到页面正常登录/触发一次加密，Diffuzz 会自动取出公钥并填入脚本。</div>`
      : '';

  let html = libNote + keyNote;
  if (candidates.length) {
    const items = candidates
      .map((c) => {
        const preview = c.sample ? esc(String(c.sample).slice(0, 40)) : (c.err ? 'err' : '(无输出)');
        return `<div class="cand"><button class="btn ghost" data-cand="${esc(c.ref)}">${esc(c.name)}</button>` +
          `<span class="hint">${esc(c.ref)} ｜ ${preview} ｜ 分${c.score}${c.deterministic ? ' · 稳定' : ' · 每次不同'}</span></div>`;
      })
      .join('');
    html += items + '<div class="hint">点函数名自动填入上面脚本</div>';
  } else if (!keys.length && !wantLib) {
    html += '未发现明显全局加密函数，也没检测到常见加密库。可能是藏在闭包/模块里——请改用手动脚本，或在控制台确认页面实际用的加密方式。';
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-cand]').forEach((b) =>
    b.addEventListener('click', () => {
      $('encryptScript').value = suggestScript(b.dataset.cand);
      $('encryptStatus').textContent = '已填入 ' + b.dataset.cand + '，点「用页面JS加密全部Payload」';
    })
  );
  const rsaBtn = box.querySelector('[data-gen-rsa]');
  if (rsaBtn) {
    rsaBtn.addEventListener('click', () => {
      $('encryptScript').value = suggestJsenEncryptScript(keys[0]);
      $('encryptStatus').textContent = '已填入 JSEncrypt 脚本（公钥已内嵌），直接点「用页面JS加密全部Payload」';
    });
  }
  // 注入 JSEncrypt 钩子：注入后自动轮询捕获公钥，拿到就自动填入脚本（免手动二次按钮）
  const hookBtn = box.querySelector('[data-hook-jsenc]');
  if (hookBtn) {
    hookBtn.addEventListener('click', async () => {
      hookBtn.disabled = true;
      const r = await installJSenHook();
      if (r.error) {
        hookBtn.disabled = false;
        $('encryptStatus').textContent = '注入失败：' + r.error;
        return;
      }
      $('encryptStatus').textContent = '钩子已注入。现在去目标页面触发一次真实加密（登录提交/刷新即可）…Diffuzz 会自动读取公钥';
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const key = await getCapturedPubkey();
        if (key) {
          $('encryptScript').value = suggestJsenEncryptScript(key);
          $('encryptStatus').textContent = '已捕获公钥并填入 JSEncrypt 脚本，点「用页面JS加密全部Payload」';
          return;
        }
      }
      $('encryptStatus').textContent = '60 秒内未捕获到公钥——确认你已在页面上真正触发了一次加密（如提交登录），再重试「自动查找」';
    });
  }
});

$('encryptRun').addEventListener('click', async () => {
  const script = $('encryptScript').value.trim();
  if (!script) {
    $('encryptStatus').textContent = '请先填写带 __VAR__ 的加密表达式';
    return;
  }
  const values = editor.readPayloadLines();
  if (!values.length) {
    $('encryptStatus').textContent = 'payload 为空，先填候选值';
    return;
  }
  $('encryptStatus').textContent = `加密中 0/${values.length}…`;
  const { out, errors, total } = await encryptPayloads({
    script,
    values,
    onProgress: (i, n) => {
      $('encryptStatus').textContent = `加密中 ${i}/${n}…`;
    },
  });
  if (out.length) {
    editor.replacePayload(out);
    editor.updateEstimate();
  }
  const errMsg = errors.length ? ` · ${errors.length} 条失败（如 ${errors[0].error}）` : '';
  $('encryptStatus').textContent = `完成：加密 ${out.length}/${total} 条并回填${errMsg}`;
});

// ---------- 任务控制（直接调用，不再跨进程通信） ----------
$('pauseBtn').addEventListener('click', () => {
  const t = state.snapshot && state.snapshot.task;
  if (!t) return;
  if (/baselining|running/.test(t.status)) runner.pause('user');
  else if (t.status === 'paused') runner.resume();
});
$('abortBtn').addEventListener('click', () => {
  $('statusText').textContent = '正在终止…（中断在途请求）';
  $('statusbar').className = 'paused';
  runner.abort();
});

// 任务运行器：跑在面板自己的页面里（DevTools 开着它就活着）
const runner = new TaskRunner();
runner.addPort({ postMessage: handleTaskEvent, onDisconnect: { addListener() {} } });

function handleTaskEvent(msg) {
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
}

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

// 面板重开时没有跨进程状态可恢复（任务在面板关闭时即终止）
if (runner.task) applySnapshot(runner.snapshot());

// 全局错误兜底：面板内任何未捕获异常直接显示在状态栏，避免"无声空白"
window.addEventListener('error', (e) => {
  $('statusText').textContent = '面板异常: ' + (e.message || 'unknown');
  $('statusbar').className = 'error';
});
window.addEventListener('unhandledrejection', (e) => {
  $('statusText').textContent = '面板异常(异步): ' + ((e.reason && e.reason.message) || e.reason);
  $('statusbar').className = 'error';
});

// ---------- 三栏拖拽调宽 ----------
function initSplitters() {
  const cols = $('cols');
  const apply = (w1, w2) => {
    cols.style.gridTemplateColumns = `${w1}px 8px ${w2}px 8px minmax(300px, 1fr)`;
  };
  const wire = (id, getStart, setW) => {
    const sp = $(id);
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('active');
      const startX = e.clientX;
      const startW = getStart();
      const move = (ev) => setW(Math.round(Math.max(160, startW + ev.clientX - startX)));
      const up = () => {
        sp.classList.remove('active');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  };
  wire('split1',
    () => $('col-source').getBoundingClientRect().width,
    (w) => apply(w, $('col-editor').getBoundingClientRect().width));
  wire('split2',
    () => $('col-editor').getBoundingClientRect().width,
    (w) => apply($('col-source').getBoundingClientRect().width, w));
}
initSplitters();

updateStartState();
// 面板初始化结束
