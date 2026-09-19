// Zero-dependency test harness. `node scanner/test/run.js`.

const suites = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  if (!current) throw new Error('it() outside describe()');
  current.tests.push({ name, fn });
}

export const assert = {
  ok(v, msg = 'expected truthy') {
    if (!v) throw new Error(`${msg} (got ${JSON.stringify(v)})`);
  },
  equal(a, b, msg = 'values differ') {
    if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  close(a, b, tol = 1e-6, msg = 'values not close') {
    if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`);
  },
  between(v, lo, hi, msg = 'out of range') {
    if (!(v >= lo && v <= hi)) throw new Error(`${msg}: ${v} not in [${lo}, ${hi}]`);
  },
  deep(a, b, msg = 'deep mismatch') {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
  },
  throws(fn, msg = 'expected throw') {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error(msg);
  },
};

export async function runAll() {
  let passed = 0;
  const failures = [];
  for (const suite of suites) {
    console.log(`\n\x1b[1m${suite.name}\x1b[0m`);
    for (const t of suite.tests) {
      try {
        await t.fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
      } catch (err) {
        failures.push({ suite: suite.name, test: t.name, err });
        console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
        console.log(`    \x1b[31m${err.message}\x1b[0m`);
      }
    }
  }
  const total = passed + failures.length;
  console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed}/${total} passed\x1b[0m`);
  if (failures.length) process.exitCode = 1;
  return { passed, failures };
}
