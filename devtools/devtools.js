// DevTools 入口：注册 Diffuzz 面板
chrome.devtools.panels.create('Diffuzz', null, 'panel/index.html', (panel) => {
  // 面板首次被用户切到时触发 onShown；无额外初始化需求
});
