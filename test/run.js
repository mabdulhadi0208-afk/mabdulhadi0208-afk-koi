// Runs Koi's tests under xvfb (Linux) or directly (macOS): the smoke test, then the speed and idle harness.
//   npm test
const { spawnSync } = require('child_process'), path = require('path');
const electron = require('electron'), xvfb = process.platform === 'linux' ? ['xvfb-run', ['-a', '-s', '-screen 0 1440x900x24']] : null;
let failed = 0;
for (const [name, env] of [['smoke.js', {}], ['perm.js', {}], ['coldopen.js', { KOI_IDLE: '20', KOI_LABEL: 'npm-test' }], ['updater-e2e.js', {}], ['harness.js', { KOI_SIM: '1', KOI_LABEL: 'npm-test', KOI_CPU: '10', KOI_RUNS: '2' }]]) {
  const args = [path.join(__dirname, name), '--no-sandbox'];
  const r = xvfb ? spawnSync(xvfb[0], [...xvfb[1], electron, ...args], { stdio: 'inherit', env: { ...process.env, ...env } }) : spawnSync(electron, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) { failed++; console.log('FAIL', name, 'exited', r.status); }
}
process.exit(failed ? 1 : 0);
