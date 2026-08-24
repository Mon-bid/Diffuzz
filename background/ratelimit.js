// 限速：串行发送 + 间隔抖动（±20%）。最低 0.2 req/s（5 秒 1 个）。

const MIN_RATE = 0.2;
const MAX_RATE = 5;

export class RateLimiter {
  constructor(ratePerSec) {
    this.interval = 1000 / Math.min(MAX_RATE, Math.max(MIN_RATE, ratePerSec));
    this.last = 0;
  }

  /** 等到下一个允许发送的时刻 */
  async wait() {
    const jitter = this.interval * (0.8 + Math.random() * 0.4);
    const earliest = this.last + jitter;
    const now = Date.now();
    if (now < earliest) await sleep(earliest - now);
    this.last = Date.now();
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
