// 测试集：Node 与浏览器共用。每个用例为 {name, fn(assert)}。

import { countFuzz, locateFuzz, renderTemplate, renderBaseline, wrapSelection } from '../core/template.js';
import { normalizeBody } from '../core/normalize.js';
import { tokenize, simhash64, makeFingerprint, hammingHex } from '../core/fingerprint.js';
import { buildBaseline, analyze, clusterKey, WEIGHTS } from '../core/diff-engine.js';
import { harToTemplate, parseCurl } from '../core/har-adapter.js';
import { median, mad, robustZ, hash64 } from '../core/util.js';

// ---- 构造响应记录的工具 ----
function rec(seq, payload, { status = 200, body = 'ok', redirect = '', time = 100 } = {}) {
  const fp = makeFingerprint({ status, redirectSig: redirect, normalizedBody: body, contentType: 'text/html' });
  return { seq, payload, status, timingMs: time, fingerprint: fp, bodyText: body };
}

export const tests = [
  // ============ util ============
  {
    name: 'util: hash64 稳定且对输入敏感',
    fn: (t) => {
      t.equal(hash64('abc'), hash64('abc'));
      t.notEqual(hash64('abc'), hash64('abd'));
      t.equal(hash64('abc').length, 16);
    },
  },
  {
    name: 'util: median / mad',
    fn: (t) => {
      t.equal(median([1, 2, 3, 4, 100]), 3);
      const m = mad([1, 2, 3, 4, 100], median([1, 2, 3, 4, 100]));
      t.equal(m, 1);
    },
  },
  {
    name: 'util: robustZ 回退链',
    fn: (t) => {
      // MAD>0 走 MAD
      t.ok(Math.abs(robustZ(100, 3, 1, 22, 40) - 0.6745 * 97) < 1e-9);
      // MAD=0 但 sd>0 走 sd
      t.ok(Math.abs(robustZ(11, 10, 0, 10, 2) - 0.5) < 1e-9);
      // 全 0 二值化
      t.equal(robustZ(10, 10, 0, 10, 0), 0);
      t.equal(robustZ(11, 10, 0, 10, 0), 3);
    },
  },

  // ============ template ============
  {
    name: 'template: countFuzz / locateFuzz',
    fn: (t) => {
      const tpl = {
        urlTemplate: 'https://a.com/u/{{FUZZ}}',
        headers: [{ name: 'X-A', valueTemplate: 'fixed' }],
        bodyTemplate: null,
      };
      t.equal(countFuzz(tpl.urlTemplate), 1);
      const pos = locateFuzz(tpl);
      t.equal(pos.length, 1);
      t.equal(pos[0].type, 'url');
      // header 中
      t.equal(locateFuzz({ urlTemplate: 'https://a.com/', headers: [{ name: 'X-A', valueTemplate: '{{FUZZ}}' }], bodyTemplate: null }).length, 1);
      // 多个占位符应报多个
      t.equal(locateFuzz({ urlTemplate: 'https://a.com/{{FUZZ}}', headers: [{ name: 'X', valueTemplate: '{{FUZZ}}' }], bodyTemplate: null }).length, 2);
    },
  },
  {
    name: 'template: renderTemplate URL 编码与 body 原文',
    fn: (t) => {
      const tpl = {
        urlTemplate: 'https://a.com/u/{{FUZZ}}?x=1',
        headers: [{ name: 'X-A', valueTemplate: 'v={{FUZZ}}' }],
        bodyTemplate: '{"id":"{{FUZZ}}"}',
      };
      const r = renderTemplate(tpl, 'a b/c');
      t.equal(r.url, 'https://a.com/u/a%20b%2Fc?x=1');
      t.equal(r.headers[0].value, 'v=a b/c');
      t.equal(r.body, '{"id":"a b/c"}');
    },
  },
  {
    name: 'template: urlencode 修饰符',
    fn: (t) => {
      const r = renderTemplate({ urlTemplate: 'https://a.com/', headers: [], bodyTemplate: '{{FUZZ:urlencode}}' }, 'a b');
      t.equal(r.body, 'a%20b');
    },
  },
  {
    name: 'template: renderBaseline 用原始值还原',
    fn: (t) => {
      const tpl = {
        urlTemplate: 'https://a.com/u/{{FUZZ}}',
        headers: [],
        bodyTemplate: null,
        fuzzOriginal: '1001',
      };
      t.equal(renderBaseline(tpl).url, 'https://a.com/u/1001');
      // 无原始值时空串兜底
      t.equal(renderBaseline({ ...tpl, fuzzOriginal: null }).url, 'https://a.com/u/');
    },
  },
  {
    name: 'template: wrapSelection',
    fn: (t) => {
      const r = wrapSelection('user/1001/x', 5, 9);
      t.equal(r.text, 'user/{{FUZZ}}/x');
      t.equal(r.original, '1001');
      t.equal(wrapSelection('abc', 1, 1), null);
    },
  },

  // ============ normalize ============
  {
    name: 'normalize: 毫秒/秒时间戳打码',
    fn: (t) => {
      const out = normalizeBody('{"t":1724426400000,"s":1724426400}');
      t.ok(out.includes('<ts>'));
      t.ok(!out.includes('1724426400'));
    },
  },
  {
    name: 'normalize: CSRF key 打码',
    fn: (t) => {
      const out = normalizeBody('{"csrf_token":"abc123XYZdef456ghi","ok":true}');
      t.ok(out.includes('"<token>"'));
      t.ok(!out.includes('abc123XYZdef456ghi'));
    },
  },
  {
    name: 'normalize: 高熵 hex 打码、普通文本保留',
    fn: (t) => {
      const out = normalizeBody('id=deadbeefdeadbeefdeadbeef name=alice');
      t.ok(out.includes('<token>'));
      t.ok(out.includes('alice'));
    },
  },
  {
    name: 'normalize: 噪声打码后两次响应归一化一致',
    fn: (t) => {
      const a = normalizeBody('{"ts":1724426400001,"token":"aabbccddeeff00112233","data":"hello"}');
      const b = normalizeBody('{"ts":1724426400999,"token":"998877665544ffeeddccb","data":"hello"}');
      t.equal(a, b);
    },
  },
  {
    name: 'normalize: 用户规则优先',
    fn: (t) => {
      const out = normalizeBody('balance=999', [{ pattern: 'balance=\\d+', replacement: 'balance=<n>' }]);
      t.equal(out, 'balance=<n>');
    },
  },
  {
    name: 'normalize: 非法用户正则不抛异常',
    fn: (t) => {
      t.doesNotThrow(() => normalizeBody('x', [{ pattern: '(' }]));
    },
  },

  // ============ fingerprint ============
  {
    name: 'fingerprint: tokenize 行与 shingle',
    fn: (t) => {
      const tk = tokenize('a b c d\nef\n\n');
      t.ok(tk.includes('ef'));
      t.ok(tk.length >= 2);
    },
  },
  {
    name: 'fingerprint: 相同文本 simhash 相同，小改动汉明距小',
    fn: (t) => {
      const a = simhash64(tokenize('hello world foo bar\nline two here'));
      const b = simhash64(tokenize('hello world foo bar\nline two here'));
      const c = simhash64(tokenize('COMPLETELY different content here\nnothing alike'));
      t.equal(a, b);
      t.ok(hammingHex(a, c) > 10, '不同文本汉明距应显著');
    },
  },
  {
    name: 'fingerprint: makeFingerprint lenBucket 对数分桶',
    fn: (t) => {
      const fp = makeFingerprint({ status: 200, redirectSig: '', normalizedBody: 'x'.repeat(300), contentType: 'text/html; charset=utf-8' });
      t.equal(fp.lenBucket, 8);
      t.equal(fp.contentType, 'text/html');
    },
  },

  // ============ diff-engine ============
  {
    name: 'diff-engine: buildBaseline 稳定/不稳定',
    fn: (t) => {
      const r1 = rec(0, null, { body: 'same' });
      const r2 = rec(0, null, { body: 'same' });
      t.equal(buildBaseline([r1, r2]).stable, true);
      const r3 = rec(0, null, { body: 'other' });
      t.equal(buildBaseline([r1, r2, r3]).stable, false);
      // 众数簇
      t.equal(buildBaseline([r1, r2, r3]).fingerprint.simhash64, r1.fingerprint.simhash64);
    },
  },
  {
    name: 'diff-engine: IDOR 场景 - 状态码/跳转/正文异常被置顶',
    fn: (t) => {
      const baseline = buildBaseline([rec(0, null, { body: 'normal user page with some content' })]);
      const records = [];
      for (let i = 1; i <= 50; i++) records.push(rec(i, String(i), { body: 'normal user page with some content' }));
      records.push(rec(51, '1337', { body: 'admin secret data that is much longer and different' })); // 正文异常
      records.push(rec(52, '1', { status: 302, redirect: 'a.com/login' })); // 跳转异常
      records.push(rec(53, 'x', { status: 404, body: 'not found' })); // 状态码异常
      const results = analyze(records, baseline);
      const byScore = [...results].sort((a, b) => b.anomalyScore - a.anomalyScore);
      // 三条异常应占据前三且显著高于正常记录
      t.ok([51, 52, 53].includes(byScore[0].seq));
      t.ok([51, 52, 53].includes(byScore[1].seq));
      t.ok([51, 52, 53].includes(byScore[2].seq));
      t.ok(byScore[2].anomalyScore > byScore[3].anomalyScore + 1, '异常与正常记录之间应有明显分差');
      // 正常记录低分
      const normal = results.find((r) => r.seq === 5);
      t.ok(normal.anomalyScore < 0.5);
    },
  },
  {
    name: 'diff-engine: 含噪声响应不打星（归一化后一致）',
    fn: (t) => {
      const mk = (i, noise) => rec(i, String(i), { body: normalizeBody(`{"ts":${noise},"data":"same"}`) });
      const baseline = buildBaseline([mk(0, 1724426400001)]);
      const records = [];
      for (let i = 1; i <= 20; i++) records.push(mk(i, 1724426400000 + i * 7));
      const results = analyze(records, baseline);
      t.ok(results.every((r) => r.anomalyScore < 0.5));
    },
  },
  {
    name: 'diff-engine: 耗时异常贡献低权重分',
    fn: (t) => {
      const baseline = buildBaseline([rec(0, null, { time: 100 })]);
      const records = [];
      for (let i = 1; i <= 40; i++) records.push(rec(i, String(i), { time: 100 + (i % 2) }));
      records.push(rec(41, 'slow', { time: 3000 }));
      const results = analyze(records, baseline);
      const slow = results.find((r) => r.seq === 41);
      const normal = results.find((r) => r.seq === 1);
      t.ok(slow.anomalyScore > normal.anomalyScore);
      t.ok(slow.anomalyScore < WEIGHTS.statusDiff, '纯耗时异常不应超过状态码权重');
    },
  },
  {
    name: 'diff-engine: clusterKey 一致',
    fn: (t) => {
      const a = rec(1, 'x');
      const b = rec(2, 'y');
      t.equal(clusterKey(a.fingerprint), clusterKey(b.fingerprint));
    },
  },

  // ============ har-adapter ============
  {
    name: 'har: harToTemplate 剔除伪头并锁定 host',
    fn: (t) => {
      const tpl = harToTemplate({
        request: {
          method: 'POST',
          url: 'https://api.example.com/v1/user',
          headers: [
            { name: ':authority', value: 'api.example.com' },
            { name: 'content-length', value: '10' },
            { name: 'authorization', value: 'Bearer x' },
          ],
          postData: { text: '{"a":1}' },
        },
      });
      t.equal(tpl.method, 'POST');
      t.equal(tpl.originHost, 'api.example.com');
      t.equal(tpl.headers.length, 1);
      t.equal(tpl.headers[0].name, 'authorization');
      t.equal(tpl.bodyTemplate, '{"a":1}');
    },
  },
  {
    name: 'curl: 基本解析（-H/-d 默认 POST）',
    fn: (t) => {
      const tpl = parseCurl(`curl 'https://a.com/api' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer eyJx' \\\n  --data-raw '{"id":1}'`);
      t.ok(tpl);
      t.equal(tpl.method, 'POST');
      t.equal(tpl.urlTemplate, 'https://a.com/api');
      t.equal(tpl.headers.length, 2);
      t.equal(tpl.bodyTemplate, '{"id":1}');
    },
  },
  {
    name: 'curl: -X GET 与无 body',
    fn: (t) => {
      const tpl = parseCurl("curl -X GET 'https://a.com/x?y=1' -H 'Accept: */*'");
      t.equal(tpl.method, 'GET');
      t.equal(tpl.bodyTemplate, null);
      t.equal(tpl.headers[0].name, 'Accept');
    },
  },
  {
    name: 'curl: 非法输入返回 null',
    fn: (t) => {
      t.equal(parseCurl('not a curl'), null);
      t.equal(parseCurl(''), null);
    },
  },
];
