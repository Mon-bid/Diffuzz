// ③ 结果表：分页渲染、按异常分排序、导出 CSV/JSON

const PAGE = 100;
const ANOMALY_THRESHOLD = 0.5;

export function initResults({ onSelectRow }) {
  const bodyEl = document.getElementById('resultBody');
  const moreEl = document.getElementById('moreRows');
  const sortEl = document.getElementById('sortBy');
  const baselineBox = document.getElementById('baselineBox');

  const state = {
    records: [],
    results: [],
    resultMap: new Map(),
    sortBy: 'score',
    shown: PAGE,
    selectedSeq: null,
  };

  function fmtBytes(n) {
    if (n == null) return '-';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
    if (n >= 1024) return (n / 1024).toFixed(1) + 'K';
    return String(n);
  }

  function rows() {
    const joined = [];
    for (const r of state.records) {
      const d = state.resultMap.get(r.seq);
      joined.push({ r, d });
    }
    const cmp = {
      score: (a, b) => ((b.d && b.d.anomalyScore) || 0) - ((a.d && a.d.anomalyScore) || 0) || a.r.seq - b.r.seq,
      seq: (a, b) => a.r.seq - b.r.seq,
      status: (a, b) => a.r.status - b.r.status || a.r.seq - b.r.seq,
      len: (a, b) => (b.r.fingerprint ? b.r.fingerprint.lenNorm : 0) - (a.r.fingerprint ? a.r.fingerprint.lenNorm : 0),
      time: (a, b) => b.r.timingMs - a.r.timingMs,
    }[state.sortBy];
    return joined.sort(cmp);
  }

  function render() {
    const data = rows();
    const frag = document.createDocumentFragment();
    for (const { r, d } of data.slice(0, state.shown)) {
      const tr = document.createElement('tr');
      if (d && d.anomalyScore >= ANOMALY_THRESHOLD) tr.className = 'anom';
      if (r.seq === state.selectedSeq) tr.classList.add('sel');
      const cells = [
        `<td>${r.seq}</td>`,
        `<td title="${escapeHtml(r.payload ?? '')}">${escapeHtml(String(r.payload ?? '-')).slice(0, 40)}</td>`,
        r.skipped
          ? `<td colspan="4">跳过: ${escapeHtml(r.note || '')}</td>`
          : `<td>${r.networkError ? 'ERR' : r.status}</td>
             <td class="num">${fmtBytes(r.fingerprint ? r.fingerprint.lenNorm : 0)}</td>
             <td class="num">${r.timingMs}ms</td>
             <td class="num">${d ? d.anomalyScore.toFixed(1) : '-'}<span class="star">★</span></td>`,
      ];
      tr.innerHTML = cells.join('');
      tr.addEventListener('click', () => {
        state.selectedSeq = r.seq;
        render();
        onSelectRow(r, d);
      });
      frag.appendChild(tr);
    }
    bodyEl.replaceChildren(frag);
    moreEl.hidden = state.shown >= data.length;
    moreEl.textContent = `显示更多（${Math.min(state.shown, data.length)}/${data.length}）`;
  }

  moreEl.addEventListener('click', () => {
    state.shown += PAGE;
    render();
  });
  sortEl.addEventListener('change', () => {
    state.sortBy = sortEl.value;
    render();
  });

  function setData({ records = [], results = [], baseline = null } = {}) {
    state.records = records;
    state.results = results;
    state.resultMap = new Map(results.map((d) => [d.seq, d]));
    state.shown = PAGE;
    if (baseline) {
      const fp = baseline.fingerprint;
      baselineBox.textContent = baseline.stable
        ? `基线: ${fp.status}, 归一化长度 ${fp.lenNorm}, ${fp.contentType || '-'}（稳定）`
        : `⚠ 基线不稳定（3 次响应互不一致），建议增加忽略规则；已取多数簇`;
    } else {
      baselineBox.textContent = '尚无基线';
    }
    render();
  }

  // ---- 导出 ----
  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  document.getElementById('exportCsv').addEventListener('click', () => {
    const head = 'seq,payload,status,lenNorm,bodyBytes,timingMs,redirect,cluster,anomalyScore,statusDiff,redirectDiff,lenZ,simhashDist,timingZ';
    const lines = rows().map(({ r, d }) => {
      const fp = r.fingerprint || {};
      const s = (d && d.signals) || {};
      return [
        r.seq, csv(r.payload), r.networkError ? 'ERR' : r.status, fp.lenNorm ?? '', r.bodyBytes, r.timingMs,
        csv(fp.redirectSig || ''), d ? d.clusterId : '', d ? d.anomalyScore : '',
        s.statusDiff ?? '', s.redirectDiff ?? '', s.lenZ ?? '', s.simhashDist ?? '', s.timingZ ?? '',
      ].join(',');
    });
    download(`diffuzz-${Date.now()}.csv`, 'text/csv', '﻿' + [head, ...lines].join('\n'));
  });

  document.getElementById('exportJson').addEventListener('click', () => {
    const out = rows().map(({ r, d }) => ({
      seq: r.seq,
      payload: r.payload,
      status: r.status,
      networkError: r.networkError,
      finalUrl: r.finalUrl,
      fingerprint: r.fingerprint,
      headers: r.headers,
      timingMs: r.timingMs,
      bodyPreview: (r.bodyText || '').slice(0, 4096),
      diff: d,
    }));
    download(`diffuzz-${Date.now()}.json`, 'application/json', JSON.stringify(out, null, 2));
  });

  function csv(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { setData, render };
}
