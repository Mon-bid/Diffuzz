// ① 捕获请求列表：实时 onRequestFinished + getHAR 历史

export function initRequestList({ onSelect }) {
  const listEl = document.getElementById('captureList');
  const filterEl = document.getElementById('captureFilter');
  const methodEl = document.getElementById('methodFilter');

  const state = {
    items: [], // {id, method, url, harEntry}
    activeId: null,
    filter: '',
    method: '',
  };
  const MAX_ITEMS = 2000;

  function visible() {
    const f = state.filter.toLowerCase();
    const KNOWN = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
    return state.items.filter((it) => {
      if (state.method === '其他') {
        if (KNOWN.includes(it.method)) return false;
      } else if (state.method && it.method !== state.method) {
        return false;
      }
      return !f || it.url.toLowerCase().includes(f);
    });
  }

  function render() {
    const items = visible();
    const frag = document.createDocumentFragment();
    // 最新在上
    for (let i = items.length - 1; i >= 0 && frag.childNodes.length < 500; i--) {
      const it = items[i];
      const li = document.createElement('li');
      li.dataset.id = it.id;
      if (it.id === state.activeId) li.className = 'active';
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = it.method;
      li.appendChild(m);
      li.appendChild(document.createTextNode(it.url));
      li.title = it.method + ' ' + it.url;
      frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
  }

  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const it = state.items.find((x) => x.id === li.dataset.id);
    if (!it) return;
    state.activeId = it.id;
    render();
    onSelect(it);
  });

  filterEl.addEventListener('input', () => {
    state.filter = filterEl.value.trim();
    render();
  });

  methodEl.addEventListener('change', () => {
    state.method = methodEl.value;
    render();
  });

  let idSeq = 1;
  function add(harEntry) {
    const req = harEntry.request;
    if (!req || !/^https?:/i.test(req.url)) return;
    state.items.push({
      id: 'c' + idSeq++,
      method: req.method,
      url: req.url,
      harEntry,
    });
    if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
    render();
  }

  // 实时捕获
  if (chrome.devtools && chrome.devtools.network) {
    chrome.devtools.network.onRequestFinished.addListener(add);
    // 历史补齐
    chrome.devtools.network.getHAR((har) => {
      if (har && Array.isArray(har.entries)) {
        for (const entry of har.entries) add(entry);
      }
    });
  }

  function getSelected() {
    return state.items.find((x) => x.id === state.activeId) || null;
  }

  return { add, render, getSelected };
}
