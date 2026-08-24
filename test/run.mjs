// Node 测试入口：node test/run.mjs
import { tests } from './tests.js';

let pass = 0;
let fail = 0;
const failures = [];

for (const t of tests) {
  const assert = {
    equal: (a, b, msg) => {
      if (a !== b) throw new Error(`${msg || 'equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    },
    notEqual: (a, b, msg) => {
      if (a === b) throw new Error(`${msg || 'notEqual'}: both ${JSON.stringify(a)}`);
    },
    ok: (v, msg) => {
      if (!v) throw new Error(msg || 'falsy');
    },
    doesNotThrow: (fn) => {
      try {
        fn();
      } catch (e) {
        throw new Error(`unexpected throw: ${e.message}`);
      }
    },
  };
  try {
    await t.fn(assert);
    pass++;
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    fail++;
    failures.push([t.name, e.message]);
    console.error(`  ✗ ${t.name}\n      ${e.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
process.exit(fail ? 1 : 0);
