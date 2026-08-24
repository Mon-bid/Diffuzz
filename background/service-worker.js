// Service Worker 入口：消息路由 + 面板长连接
import { TaskRunner } from './task-runner.js';
import { sendOnce } from './sender.js';

const runner = new TaskRunner();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'diffuzz-panel') runner.addPort(port);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'task/start': {
        runner.allowIntranet = !!msg.allowIntranet;
        const r = await runner.start({ template: msg.template, config: msg.config });
        sendResponse(r);
        break;
      }
      case 'task/pause':
        runner.pause('user');
        sendResponse({ ok: true });
        break;
      case 'task/resume':
        runner.resume();
        sendResponse({ ok: true });
        break;
      case 'task/abort':
        runner.abort();
        sendResponse({ ok: true });
        break;
      case 'task/state': {
        if (runner.task) {
          sendResponse({ ok: true, snapshot: runner.snapshot() });
        } else {
          // SW 重启后内存丢失：读取上次任务元信息并标记中断
          const stored = (await chrome.storage.session.get('diffuzzLastTask')).diffuzzLastTask;
          if (stored && /baselining|running|paused/.test(stored.status)) {
            sendResponse({
              ok: true,
              interrupted: true,
              snapshot: {
                task: { ...stored, status: 'error', error: 'Service Worker 重启，任务已中断，请重新发起' },
                baselineRecords: [], baseline: null, records: [], results: [],
              },
            });
          } else {
            sendResponse({ ok: true, snapshot: null });
          }
        }
        break;
      }
      case 'debug/replay': {
        // 原样重放一条请求（不含 FUZZ），用于验证登录态与头覆盖
        const rec = await sendOnce({
          url: msg.url,
          method: msg.method,
          headers: msg.headers || [],
          body: msg.body ?? null,
          followRedirect: msg.followRedirect !== false,
          timeoutMs: msg.timeoutMs || 15000,
        });
        sendResponse({ ok: true, record: rec });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message: ' + (msg && msg.type) });
    }
  })();
  return true; // 异步 sendResponse
});
