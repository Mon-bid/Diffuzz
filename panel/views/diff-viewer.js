// 响应查看器：两个页签——响应详情（单条回包）/ 基线对比（LCS 行 diff）
// 整块 #diffBody 可拖拽上下调整高度（CSS resize）

const MAX_LINES = 1500;
const BODY_DISPLAY_CAP = 16 * 1024;

export function initDiffViewer() {
  const box = document.getElementById('diffViewer');
  const title = document.getElementById('diffTitle');
  const signals = document.getElementById('diffSignals');
  const left = document.getElementById('diffLeft');
  const right = document.getElementById('diffRight');
  const detail = document.getElementById('detailPane');
  const diffCols = left.parentElement;
  const closeBtn = document.getElementById('diffClose');
  const tabDetail = document.getElementById('tabDetail');
  const tabDiff = document.getElementById('tabDiff');

  let activeTab = 'detail'; // 默认响应详情
  let cur = { baselineRecord: null, record: null, diff: null };
  let prettyBody = true; // 正文默认「美化+高亮」，可切回原文

  closeBtn.addEventListener('click', () => {
    box.hidden = true;
  });
  // Esc / 点击遮罩空白关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.hidden) box.hidden = true;
  });
  box.addEventListener('click', (e) => {
    if (e.target === box) box.hidden = true;
  });
  tabDetail.addEventListener('click', () => setActiveTab('detail'));
  tabDiff.addEventListener('click', () => setActiveTab('diff'));
  // 详情面板内的按钮走事件委托（innerHTML 每次重建，冒泡到容器最稳）
  detail.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="toggleBody"]');
    if (btn) {
      prettyBody = !prettyBody;
      renderDetail(cur.record);
    }
  });

  function setActiveTab(t) {
    activeTab = t;
    detail.hidden = t !== 'detail';
    diffCols.hidden = t !== 'diff';
    tabDetail.classList.toggle('primary', t === 'detail');
    tabDiff.classList.toggle('primary', t === 'diff');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 美化 JSON：解析失败返回 null */
  function prettyJson(str) {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch {
      return null;
    }
  }

  /** 对已美化的 JSON 做一次性 tokenize 语法高亮 */
  function highlightPretty(pretty) {
    // 匹配：字符串(可能紧跟冒号=键) / 数字 / 布尔 / null / 结构符
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false)\b|\b(null)\b|([\[\]{}:,])/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(pretty))) {
      if (m.index > last) out += escapeHtml(pretty.slice(last, m.index));
      if (m[1]) {
        out += `<span class="${m[2] ? 'json-key' : 'json-str'}">${escapeHtml(m[1])}</span>`;
        if (m[2]) out += escapeHtml(m[2]); // 冒号
      } else if (m[3]) {
        out += `<span class="json-num">${escapeHtml(m[3])}</span>`;
      } else if (m[4]) {
        out += `<span class="json-bool">${escapeHtml(m[4])}</span>`;
      } else if (m[5]) {
        out += `<span class="json-null">${escapeHtml(m[5])}</span>`;
      } else if (m[6]) {
        out += `<span class="json-pun">${escapeHtml(m[6])}</span>`;
      }
      last = re.lastIndex;
    }
    if (last < pretty.length) out += escapeHtml(pretty.slice(last));
    return out;
  }

  /** 响应详情页签：元信息 / 响应头 / 正文 三段折叠 */
  function renderDetail(r) {
    if (!r) {
      detail.replaceChildren();
      return;
    }
    const kv = (k, v) => `<div><span class="k">${escapeHtml(k)}:</span> <span class="v">${escapeHtml(v)}</span></div>`;
    const meta = [
      `<div class="st">${r.networkError ? 'ERR ' + escapeHtml(r.networkError) : 'HTTP ' + r.status + ' ' + escapeHtml(r.statusText || '')}</div>`,
      kv('最终 URL', r.finalUrl || '-'),
      kv('跳转', r.fingerprint && r.fingerprint.redirectSig ? r.fingerprint.redirectSig : '无'),
      kv('类型', r.contentType || '-'),
      kv('大小', (r.bodyBytes || 0) + 'B · 归一化长度 ' + (r.fingerprint ? r.fingerprint.lenNorm : '-')),
      kv('耗时', (r.timingMs || 0) + 'ms'),
      r.capped ? kv('正文', '已截断（>2MB）') : '',
    ].join('');

    const hdrs = Object.entries(r.headers || {});
    const hdrHtml = hdrs.length
      ? `<details class="sec-d"><summary>响应头 (${hdrs.length})</summary>` + hdrs.map(([k, v]) => kv(k, v)).join('') + '</details>'
      : '';

    const ct = (r.contentType || '').split(';')[0] || '';
    const rawBytes = r.bodyBytes || 0;
    let body = r.bodyText || '';
    const truncated = !!r.capped || /<截断于/.test(body) || body.length > BODY_DISPLAY_CAP;
    if (body.length > BODY_DISPLAY_CAP) {
      body = body.slice(0, BODY_DISPLAY_CAP) + `\n…（显示前 ${BODY_DISPLAY_CAP / 1024}KB，全文 ${rawBytes}B）`;
    }
    const isJson =
      (ct.toLowerCase().includes('json') || /^[\s]*[{\[]/.test(body.slice(0, 64))) &&
      prettyJson(body) != null;
    let bodyHtml = '<span class="k">（空）</span>';
    let chars = 0;
    if (body) {
      if (isJson && prettyBody) {
        bodyHtml = highlightPretty(prettyJson(body));
        chars = prettyJson(body).length; // 美化后字符数（与实际渲染一致）
      } else {
        bodyHtml = escapeHtml(body);
        chars = body.length; // 原文/非 JSON 的实际字符数
      }
    }
    // non-JSON 不显示「美化/原文」切换（点了无变化会让人困惑）；JSON 才给切换
    const toggleHtml = isJson
      ? `<div class="sec-tools"><button class="btn ghost" data-act="toggleBody">${prettyBody ? '原文' : '美化'}</button></div>`
      : '';
    const bodySec =
      `<details open class="sec-d"><summary>正文（${escapeHtml(ct || '?')} · 显示 ${chars} 字符 / 原始 ${rawBytes}B${truncated ? ' · 已截断' : ''}）</summary>` +
      toggleHtml +
      `<div class="body">${bodyHtml}</div></details>`;

    detail.innerHTML =
      `<details open class="sec-d"><summary>响应摘要</summary>${meta}</details>` +
      hdrHtml + bodySec;
  }

  /** LCS 行 diff（基线对比页签） */
  function diffLines(a, b) {
    const A = a.split('\n').slice(0, MAX_LINES);
    const B = b.split('\n').slice(0, MAX_LINES);
    const n = A.length;
    const m = B.length;
    if (n * m > 4_000_000) {
      return [...A.map((t) => ({ type: 'del', text: t })), ...B.map((t) => ({ type: 'add', text: t }))];
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        out.push({ type: 'same', text: A[i] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: 'del', text: A[i] });
        i++;
      } else {
        out.push({ type: 'add', text: B[j] });
        j++;
      }
    }
    while (i < n) out.push({ type: 'del', text: A[i++] });
    while (j < m) out.push({ type: 'add', text: B[j++] });
    return out;
  }

  function renderPane(pane, items, keepType) {
    // 左侧显示 same+del（基线独有），右侧显示 same+add（本条独有）
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if (it.type === keepType) {
        const span = document.createElement('span');
        span.className = it.type === 'add' ? 'd-add' : 'd-del';
        span.textContent = it.text + '\n';
        frag.appendChild(span);
      } else if (it.type === 'same') {
        frag.appendChild(document.createTextNode(it.text + '\n'));
      }
    }
    pane.replaceChildren(frag);
  }

  function renderDiff() {
    const { baselineRecord, record } = cur;
    const items = diffLines(baselineRecord ? baselineRecord.bodyText || '' : '', record.bodyText || '');
    renderPane(left, items, 'del');
    renderPane(right, items, 'add');
  }

  function show(baselineRecord, record, diff) {
    cur = { baselineRecord, record, diff };
    box.hidden = false;
    title.textContent = `#${record.seq}  payload=${record.payload ?? ''}`;
    if (diff) {
      const s = diff.signals;
      signals.textContent =
        `异常分 ${diff.anomalyScore} ｜ 状态${s.statusDiff ? '⚠不同' : '同'} 跳转${s.redirectDiff ? '⚠不同' : '同'} ` +
        `长度z=${s.lenZ} simhash距=${s.simhashDist} 耗时z=${s.timingZ}`;
    } else {
      signals.textContent = '（分析完成前）';
    }
    renderDetail(record);
    renderDiff();
    setActiveTab(activeTab);
  }

  return { show };
}
