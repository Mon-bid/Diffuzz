// 端到端冒烟：不起浏览器，直接用 TaskRunner 跑一个真实任务打本地靶机
// 用法：先 node test/server.mjs 8787，再 node scripts/smoke.mjs
import { TaskRunner } from '../background/task-runner.js';

const base = 'http://127.0.0.1:8787';
const runner = new TaskRunner();
runner.allowIntranet = true; // 靶机是本机

const events = [];
runner.addPort({ postMessage: (m) => events.push(m), onDisconnect: { addListener() {} } });

const template = {
  id: 'smoke',
  source: 'manual',
  method: 'GET',
  urlTemplate: `${base}/api/user/{{FUZZ}}`,
  headers: [],
  bodyTemplate: null,
  originHost: '127.0.0.1:8787',
  fuzzOriginal: '1001',
};
const config = {
  payloads: ['1000', '1001', '1002', '1337', '1', '9999'],
  ratePerSec: 5,
  followRedirect: true,
  baselineRuns: 2,
  timeoutMs: 5000,
  ignoreRules: [],
};

const r = await runner.start({ template, config });
console.log('start ->', r);
if (!r.ok) process.exit(1);

// 等任务结束
const t0 = Date.now();
while (runner.task && !/done|aborted|error/.test(runner.task.status)) {
  if (Date.now() - t0 > 30000) { console.log('超时未完成'); process.exit(1); }
  await new Promise((s) => setTimeout(s, 200));
}

console.log('task.status =', runner.task.status, 'stats =', runner.task.stats);
console.log('records:', runner.records.length, '->', runner.records.map((x) => `${x.seq}:${x.payload}=${x.networkError ? 'ERR' : x.status}`).join(' '));
console.log('baseline stable =', runner.baseline && runner.baseline.stable);
console.log('results:');
for (const d of runner.results.sort((a, b) => b.anomalyScore - a.anomalyScore)) {
  console.log(`  seq=${d.seq} payload=${d.payload} score=${d.anomalyScore} cluster=${d.clusterId} sig=${JSON.stringify(d.signals)}`);
}
const types = {};
for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
console.log('broadcast events:', JSON.stringify(types));
