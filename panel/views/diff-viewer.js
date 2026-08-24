// 差异对比视图：基线 vs 选中响应，行级 LCS diff

const MAX_LINES = 1500;

export function initDiffViewer() {
  const box = document.getElementById('diffViewer');
  const title = document.getElementById('diffTitle');
  const signals = document.getElementById('diffSignals');
  const left = document.getElementById('diffLeft');
  const right = document.getElementById('diffRight');
  const closeBtn = document.getElementById('diffClose');

  closeBtn.addEventListener('click', () => {
    box.hidden = true;
  });

  /**
   * LCS 行 diff。
   * 返回 [{type:'same'|'add'|'del', text}]，以右侧（本条）为主视角。
   */
  function diffLines(a, b) {
    const A = a.split('\n').slice(0, MAX_LINES);
    const B = b.split('\n').slice(0, MAX_LINES);
    const n = A.length;
    const m = B.length;
    // O(n*m) DP，限制规模
    if (n * m > 4_000_000) return [...A.map((t) => ({ type: 'del', text: t })), ...B.map((t) => ({ type: 'add', text: t }))];
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
    // keepType: 左侧显示 same+del，右侧显示 same+add
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

  function show(baselineRecord, record, diff) {
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
    const items = diffLines(baselineRecord ? baselineRecord.bodyText || '' : '', record.bodyText || '');
    renderPane(left, items, 'del');
    renderPane(right, items, 'add');
  }

  return { show };
}
