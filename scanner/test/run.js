#!/usr/bin/env node
// Test entry point: `node scanner/test/run.js`

import { runAll } from './harness.js';

await import('./indicators.test.js');
await import('./orderflow.test.js');
await import('./signal.test.js');
await import('./backtest.test.js');
await import('./pipeline.test.js');

await runAll();
