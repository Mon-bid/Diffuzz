// 任务状态机：created -> baselining -> running -> done / paused / aborted / error
// 全部请求串行发送，经令牌桶限速；面板关闭不中断。

import { RateLimiter, sleep } from './ratelimit.js';
import { sendOnce } from './sender.js';
import { locateFuzz, renderTemplate, renderBaseline } from '../core/template.js';
import { normalizeBody } from '../core/normalize.js';
import { makeFingerprint } from '../core/fingerprint.js';
import { buildBaseline, analyze } from '../core/diff-engine.js';

const MAX_PAYLOADS = 10000;
const MAX_BODY_TEMPLATE = 512 * 1024;
const ERROR_STREAK_PAUSE = 5;

export function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h)
  );
}

/** 任务开始前的硬校验，返回错误消息或 null */
export function validateTask(template, config) {
  if (!template || !template.urlTemplate) return '缺少请求模板';
  let u;
  try {
    u = new URL(template.urlTemplate);
  } catch {
    return 'URL 无法解析';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '仅支持 http/https';
  if (new URL(u.href).host !== template.originHost) return 'URL 与来源 host 不一致';
  const positions = locateFuzz(template);
  if (positions.length === 0) return '未找到 {{FUZZ}} 占位符';
  if (positions.length > 1) return '发现 ' + positions.length + ' 个 {{FUZZ}} 占位符，请只保留一个';
  if (!Array.isArray(config.payloads) || !config.payloads.length) return 'payload 列表为空';
  if (config.payloads.length > MAX_PAYLOADS) return 'payload 超过上限 ' + MAX_PAYLOADS;
  if (template.bodyTemplate && template.bodyTemplate.length > MAX_BODY_TEMPLATE) return '请求体超过 512KB 上限';
  return null;
}

export class TaskRunner {
  constructor() {
    this.task = null;
    this.baselineRecords = [];
    this.baseline = null;
    this.records = [];
    this.results = [];
    this.ports = new Set();
    this.paused = false;
    this.aborted = false;
    this.allowIntranet = false;
    this._pauseResolvers = [];
  }

  addPort(port) {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  broadcast(msg) {
    for (const p of this.ports) {
      try {
        p.postMessage(msg);
      } catch {
        this.ports.delete(p);
      }
    }
  }

  snapshot() {
    return {
      task: this.task,
      baselineRecords: this.baselineRecords,
      baseline: this.baseline,
      records: this.records,
      results: this.results,
    };
  }

  pause(reason) {
    this.paused = true;
    if (this.task && /running|baselining/.test(this.task.status)) {
      this.task.status = 'paused';
      this.task.pauseReason = reason || 'user';
    }
    this.broadcast({ type: 'task/state', snapshot: this.snapshot() });
  }

  resume() {
    this.paused = false;
    if (this.task && this.task.status === 'paused') this.task.status = 'running';
    this.broadcast({ type: 'task/state', snapshot: this.snapshot() });
    const rs = this._pauseResolvers;
    this._pauseResolvers = [];
    for (const r of rs) r();
  }

  abort() {
    this.aborted = true;
    this.resume(); // 唤醒可能在等待的循环
    // 立刻掐断在途请求，避免等 fetch 超时
    if (this._curAbort) {
      try {
        this._curAbort.abort();
      } catch {}
    }
    if (this.task && !/done|aborted|error/.test(this.task.status)) {
      this.task.status = 'aborted';
      this.broadcast({ type: 'task/state', snapshot: this.snapshot() });
    }
    this.broadcast({ type: 'task/aborting' });
  }

  /** 发送一条（统一挂上可中断信号） */
  async send(req, config) {
    this._curAbort = new AbortController();
    try {
      return await sendOnce({ ...req, followRedirect: config.followRedirect, timeoutMs: config.timeoutMs, signal: this._curAbort.signal });
    } finally {
      this._curAbort = null;
    }
  }

  async waitWhilePaused() {
    while (this.paused && !this.aborted) {
      await new Promise((r) => this._pauseResolvers.push(r));
      // resume() 已 resolve 所有；再兜底轮询
      if (this.paused && !this.aborted) await sleep(300);
    }
  }

  async start({ template, config }) {
    const err = validateTask(template, config);
    if (err) return { ok: false, error: err };
    if (this.task && /baselining|running/.test(this.task.status)) {
      return { ok: false, error: '已有任务在运行，请先终止' };
    }

    const mainUrl = new URL(template.urlTemplate);
    if (!this.allowIntranet && isPrivateHost(mainUrl.host)) {
      return { ok: false, error: '目标是内网/本地地址，请在设置中显式勾选"允许内网目标"' };
    }

    // 重置
    this.task = {
      id: 'T' + Date.now().toString(36),
      template,
      config,
      status: 'baselining',
      createdAt: Date.now(),
      finishedAt: null,
      stats: { total: config.payloads.length, done: 0, sent: 0, errors: 0, skipped: 0 },
    };
    this.baselineRecords = [];
    this.baseline = null;
    this.records = [];
    this.results = [];
    this.paused = false;
    this.aborted = false;

    const limiter = new RateLimiter(config.ratePerSec || 2);
    this.broadcast({ type: 'task/state', snapshot: this.snapshot() });

    const run = async () => {
      try {
        // ---- 基线 ----
        const baselineRuns = Math.max(1, Math.min(5, config.baselineRuns ?? 3));
        for (let i = 0; i < baselineRuns && !this.aborted; i++) {
          await this.waitWhilePaused();
          if (this.aborted) break;
          await limiter.wait();
          const req = renderBaseline(template);
          const rec = await this.send(req, config);
          if (this.aborted && rec.networkError === 'aborted') break;
          this.baselineRecords.push(this.decorate(rec, null, template, config));
        }
        this.baseline = buildBaseline(this.baselineRecords);
        this.broadcast({ type: 'task/baseline', baseline: this.baseline, baselineRecords: this.baselineRecords });
        if (this.aborted) return this.finish();

        // ---- 逐条发送 ----
        this.task.status = 'running';
        this.broadcast({ type: 'task/state', snapshot: this.snapshot() });

        let errorStreak = 0;
        let batch = [];
        let t0 = Date.now();
        let sentSinceTick = 0;

        for (let i = 0; i < config.payloads.length; i++) {
          await this.waitWhilePaused();
          if (this.aborted) break;
          const payload = config.payloads[i];
          const req = renderTemplate(template, payload);

          // 同源锁定：渲染后 host 被改掉的 payload 跳过
          let host = '';
          try {
            host = new URL(req.url).host;
          } catch {
            host = '';
          }
          if (host !== template.originHost) {
            this.records.push({ seq: i + 1, payload, skipped: true, note: 'host 变更，已跳过' });
            this.task.stats.skipped++;
            this.broadcast({ type: 'task/state', snapshot: this.snapshot() });
            continue;
          }

          await limiter.wait();
          if (this.aborted) break;
          const rec = await this.send(req, config);
          if (this.aborted && rec.networkError === 'aborted') break; // 被终止的请求不入表
          const decorated = this.decorate(rec, payload, template, config);
          decorated.seq = i + 1;
          this.records.push(decorated);
          this.task.stats.done++;
          this.task.stats.sent++;
          sentSinceTick++;
          if (decorated.networkError) {
            this.task.stats.errors++;
            errorStreak++;
          } else {
            errorStreak = 0;
          }
          batch.push(decorated);

          // 批量推送 + 进度
          if (batch.length >= 10) {
            this.broadcast({ type: 'task/result', records: batch });
            batch = [];
          }
          const now = Date.now();
          if (now - t0 >= 1000) {
            this.task.stats.rps = Number((sentSinceTick / ((now - t0) / 1000)).toFixed(2));
            this.broadcast({ type: 'task/progress', stats: this.task.stats, baselineStable: this.baseline.stable });
            t0 = now;
            sentSinceTick = 0;
          }

          // 429/503 或连续网络错误 -> 自动暂停
          const rateLimited = decorated.status === 429 || decorated.status === 503;
          if (rateLimited || errorStreak >= ERROR_STREAK_PAUSE) {
            this.pause(rateLimited ? '目标返回 429/503，已自动暂停' : '连续 ' + ERROR_STREAK_PAUSE + ' 次网络错误，已自动暂停');
          }
        }

        if (batch.length) this.broadcast({ type: 'task/result', records: batch });
        this.results = analyze(this.records.filter((r) => !r.skipped), this.baseline);
        this.finish();
      } catch (e) {
        this.task.status = 'error';
        this.task.error = String(e && e.message ? e.message : e);
        this.broadcast({ type: 'task/state', snapshot: this.snapshot() });
      }
    };

    run();
    return { ok: true, taskId: this.task.id };
  }

  decorate(rec, payload, template, config) {
    const normalizedBody = normalizeBody(rec.bodyText, config.ignoreRules || []);
    const fingerprint = makeFingerprint({
      status: rec.status,
      redirectSig: rec.redirectSig,
      normalizedBody,
      contentType: rec.contentType,
    });
    // 控制内存：正文全文截断（差异对比够用；归一化已在此之前完成）
    // 大任务（>2000 条）截得更狠，避免 1 万条字典把面板内存撑爆
    const cap = config.payloads.length > 2000 ? 8192 : 32768;
    const bodyText = rec.bodyText && rec.bodyText.length > cap
      ? rec.bodyText.slice(0, cap) + `\n<截断于${cap / 1024}KB>`
      : rec.bodyText;
    return { payload, ...rec, bodyText, fingerprint };
  }

  finish() {
    if (!this.task) return;
    if (this.aborted && this.task.status !== 'aborted') this.task.status = 'aborted';
    if (!/done|aborted|error/.test(this.task.status)) this.task.status = 'done';
    this.task.finishedAt = Date.now();
    if (!this.results.length && this.baseline) {
      this.results = analyze(this.records.filter((r) => !r.skipped), this.baseline);
    }
    this.broadcast({ type: 'task/done', snapshot: this.snapshot() });
  }
}
