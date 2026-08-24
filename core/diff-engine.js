// 差异引擎：基线统计、聚类、异常评分。
// 输入为带 fingerprint 的 ResponseRecord 数组，输出 DiffResult 数组。

import { clamp, median, mad, mean, stddev, robustZ, hammingHex } from './util.js';

// 异常分权重，集中此处便于调参
export const WEIGHTS = {
  statusDiff: 3.0,
  redirectDiff: 2.5,
  lenZ: 1.0,
  simhash: 4.0, // 满汉明距 64 时的得分
  timingZ: 0.5,
};

export function clusterKey(fp) {
  return `${fp.status}|${fp.redirectSig}|${fp.lenBucket}`;
}

/**
 * 由基线样本（原始请求重复发送的记录）构造基线。
 * 全部一致 -> stable；否则取众数簇并标记 unstable。
 */
export function buildBaseline(baselineRecords) {
  if (!baselineRecords.length) return { stable: false, fingerprint: null };
  const sig = (r) => r.fingerprint.simhash64 + '|' + clusterKey(r.fingerprint);
  const sigs = baselineRecords.map(sig);
  const allEqual = sigs.every((s) => s === sigs[0]);
  let chosen = baselineRecords[0];
  if (!allEqual) {
    const counts = new Map();
    for (const r of baselineRecords) counts.set(sig(r), (counts.get(sig(r)) || 0) + 1);
    let best = '';
    let bestN = -1;
    for (const [s, n] of counts) if (n > bestN) { best = s; bestN = n; }
    chosen = baselineRecords.find((r) => sig(r) === best);
  }
  return { stable: allEqual, fingerprint: chosen.fingerprint, record: chosen };
}

/**
 * 全量分析：对每条记录计算异常分。
 * @param {Array} records 带 fingerprint 的响应记录
 * @param {object} baseline buildBaseline 的输出
 * @returns {Array} 与 records 等长且同序的 DiffResult
 */
export function analyze(records, baseline) {
  if (!records.length) return [];
  const bfp = baseline.fingerprint;
  const lens = records.map((r) => r.fingerprint.lenNorm);
  const times = records.map((r) => r.timingMs || 0);
  const medL = median(lens);
  const madL = mad(lens, medL);
  const muL = mean(lens);
  const sdL = stddev(lens, muL);
  const medT = median(times);
  const madT = mad(times, medT);
  const muT = mean(times);
  const sdT = stddev(times, muT);

  // 聚类
  const clusters = new Map(); // key -> memberIdx[]
  records.forEach((r, i) => {
    const k = clusterKey(r.fingerprint);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(i);
  });
  // 最大簇 = 正常簇
  let normalKey = null;
  let normalSize = -1;
  for (const [k, members] of clusters) {
    if (members.length > normalSize) {
      normalSize = members.length;
      normalKey = k;
    }
  }
  const clusterIds = new Map([...clusters.keys()].map((k, i) => [k, i]));
  const inNormalCluster = (k) => k === normalKey;

  return records.map((r, i) => {
    const fp = r.fingerprint;
    const statusDiff = fp.status !== bfp.status ? 1 : 0;
    const redirectDiff = fp.redirectSig !== bfp.redirectSig ? 1 : 0;
    const lenZ = robustZ(fp.lenNorm, medL, madL, muL, sdL);
    const timingZ = robustZ(r.timingMs || 0, medT, madT, muT, sdT);
    const simhashDist = hammingHex(fp.simhash64, bfp.simhash64);

    let score =
      WEIGHTS.statusDiff * statusDiff +
      WEIGHTS.redirectDiff * redirectDiff +
      WEIGHTS.lenZ * clamp(Math.abs(lenZ), 0, 4) +
      WEIGHTS.simhash * (simhashDist / 64) +
      WEIGHTS.timingZ * clamp(Math.abs(timingZ), 0, 4);
    // 不在正常簇的成员至少获得簇级异常底分
    if (!inNormalCluster(clusterKey(fp))) score = Math.max(score, 1.5);
    score = clamp(score, 0, 10);

    return {
      seq: r.seq,
      payload: r.payload,
      clusterId: clusterIds.get(clusterKey(fp)),
      anomalyScore: Number(score.toFixed(3)),
      signals: {
        statusDiff,
        redirectDiff,
        lenZ: Number(lenZ.toFixed(2)),
        simhashDist,
        timingZ: Number(timingZ.toFixed(2)),
      },
    };
  });
}
