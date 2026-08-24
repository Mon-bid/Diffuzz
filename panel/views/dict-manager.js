// 字典库：命名保存 / 复用 / 导入导出 payload 字典
// 存储：chrome.storage.local.diffuzzDicts = { [name]: {content, count, updatedAt} }

const STORE_KEY = 'diffuzzDicts';

export function initDictManager({ onLoad }) {
  const nameEl = document.getElementById('dictName');
  const saveEl = document.getElementById('dictSave');
  const importEl = document.getElementById('dictImport');
  const listEl = document.getElementById('dictList');
  const payloadEl = document.getElementById('payloadInput');

  let dicts = {}; // name -> {content, count, updatedAt}

  function render() {
    const names = Object.keys(dicts).sort((a, b) => dicts[b].updatedAt - dicts[a].updatedAt);
    const frag = document.createDocumentFragment();
    for (const name of names) {
      const d = dicts[name];
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'dict-name';
      label.textContent = name;
      label.title = `${name}（${d.count} 条，预览: ${(d.content.split('\n')[0] || '').slice(0, 60)}）`;
      const load = mkBtn('载入', () => onLoad(d.content, name));
      const edit = mkBtn('编辑', () => {
        nameEl.value = name;
        payloadEl.value = d.content;
        alertHint(`已把字典 "${name}" 填入 Payload 编辑框，改完点"存为字典"覆盖`);
      });
      const exp = mkBtn('导出', () => downloadDict(name, d.content));
      // 两段式删除：DevTools 面板中原生 confirm() 会被屏蔽，不能用
      let armed = null;
      const del = mkBtn('删', async () => {
        if (armed !== name) {
          armed = name;
          del.textContent = '确认删除?';
          setTimeout(() => {
            armed = null;
            del.textContent = '删';
          }, 3000);
          return;
        }
        armed = null;
        delete dicts[name];
        await persist();
        render();
      });
      li.append(label, document.createTextNode(` (${d.count}) `), load, edit, exp, del);
      frag.appendChild(li);
    }
    if (!names.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = '暂无字典。粘贴或导入后可保存复用。';
      frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
  }

  function mkBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'btn ghost mini-btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function alertHint(msg) {
    const hint = document.getElementById('startHint');
    if (hint) hint.textContent = msg;
  }

  async function persist() {
    await chrome.storage.local.set({ [STORE_KEY]: dicts });
  }

  function parseLines(text) {
    return String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  saveEl.addEventListener('click', async () => {
    const name = nameEl.value.trim();
    if (!name) return alertHint('请先填写字典名');
    const lines = parseLines(payloadEl.value);
    if (!lines.length) return alertHint('Payload 编辑框为空，无法保存');
    dicts[name] = { content: lines.join('\n'), count: lines.length, updatedAt: Date.now() };
    await persist();
    render();
    alertHint(`字典 "${name}" 已保存（${lines.length} 条）`);
  });

  importEl.addEventListener('change', async () => {
    const file = importEl.files && importEl.files[0];
    if (!file) return;
    const text = await file.text();
    const lines = parseLines(text);
    const name = nameEl.value.trim() || file.name.replace(/\.[^.]+$/, '');
    if (!lines.length) return alertHint(`文件 ${file.name} 中没有有效行`);
    dicts[name] = { content: lines.join('\n'), count: lines.length, updatedAt: Date.now() };
    await persist();
    render();
    onLoad(dicts[name].content, name);
    alertHint(`已导入 "${name}"（${lines.length} 条）并载入 Payload`);
    importEl.value = '';
  });

  function downloadDict(name, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // 初始化：读取已存字典
  chrome.storage.local.get(STORE_KEY, (s) => {
    dicts = (s && s[STORE_KEY]) || {};
    render();
  });

  return { render };
}
