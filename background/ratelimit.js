// 限速：串行发送 + 间隔抖动（±20%）。最低 0.2 req/s（5 秒 1 个）。

const MIN_RATE = 0.2;
const MAX_RATE = 5;

export class RateLimiter {
  constructor(ratePerSec) {
    this.interval = 1000 / Math.min(MAX_RATE, Math.max(MIN_RATE, ratePerSec));
    this.last = 0;
  }

  /** 等到下一个允许发送的时刻；signal 中止时提前返回，不再等待 */
  async wait(signal) {
    const jitter = this.interval * (0.8 + Math.random() * 0.4);
    const earliest = this.last + jitter;
    const now = Date.now();
    if (now < earliest) await abortableSleep(earliest - now, signal);
    this.last = Date.now();
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 可被 AbortSignal 中断的 sleep：signal 中止时立即 resolve。
 * 返回 true 表示睡眠被取消（调用方可借此提前退出循环）。
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(true);
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve(true);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
