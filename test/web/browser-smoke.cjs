const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_LOCAL || 'playwright');
(async () => {
  const fixture = spawn(process.execPath, ['--import', 'tsx', 'examples/governance/preview.ts']);
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('fixture server startup timed out')); }, 10000);
      fixture.stdout.on('data', data => {
        const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      fixture.stderr.on('data', data => { process.stderr.write(data); });
      fixture.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited ' + code)); });
    });
    browser = await chromium.launch({ args: ['--disable-background-networking'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(7000);
    const pageErrors = [];
    const requests = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('request', r => requests.push(r.url()));
    await page.goto(url);
    await page.getByRole('button', { name: 'Kleros cases' }).click();
    await page.getByRole('button', { name: 'Details for Conviction proposal #21', exact: true }).click();
    await page.getByRole('button', { name: 'Try the demo juror' }).click();
    await page.getByText('Seat 0 · Not voted', { exact: true }).waitFor();
    await page.getByText('Seat 2 · For the challenger', { exact: true }).waitFor();
    await page.getByText('Party evidence references', { exact: true }).click();
    await page.getByText('ipfs://demo-evidence', { exact: true }).waitFor();
    await page.getByText('ipfs://demo-challenge', { exact: true }).waitFor();
    await page.getByLabel('Public ruling choice').selectOption('challenger');
    await page.getByLabel('Public justification').fill('Test covenant, browser fixture only.');
    await page.getByRole('button', { name: 'Simulate public ballot' }).click();
    await page.getByRole('heading', { name: 'Unsigned ballot simulation' }).waitFor();
    await page.getByText('castVote', { exact: true }).waitFor();
    await page.getByLabel('Public justification').fill('Change the input after the preview.');
    assert.equal(await page.getByRole('heading', { name: 'Unsigned ballot simulation' }).count(), 0);
    await page.getByLabel('Juror public wallet address').fill('0x7777777777777777777777777777777777777777');
    await page.getByRole('button', { name: 'Load my seats' }).click();
    await page.getByText('No owned seats were returned for this wallet in this round.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Simulate public ballot' }).count(), 0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Decision votes', exact: true }).click();
    await page.getByRole('button', { name: 'Details for Decision vote #0', exact: true }).click();
    await page.getByText('My Jury', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Try the demo juror' }).click();
    await page.getByText(/Jury details unavailable/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Simulate public ballot' }).count(), 0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const account = '0x' + '3'.repeat(40);
    const blockHash = '0x' + 'a5'.repeat(32);
    const delayed = process.env.HONEY_DEMO_DRAWING === '1';
    const input = delayed ? '0' : '60.000000000000000001';
    const stakeRequests = [];
    page.on('request', request => {
      if (request.url() === url + '/api/preview/stake') stakeRequests.push(request.postDataJSON());
    });
    await page.getByRole('button', { name: 'My stake', exact: true }).click();
    await page.getByRole('button', { name: 'Try the demo wallet', exact: true }).click();
    assert.equal(await page.getByLabel('Public wallet address', { exact: true }).inputValue(), account);
    await page.getByText('50 HNY', { exact: true }).first().waitFor();
    await page.getByText('12 HNY', { exact: true }).waitFor();
    const target = page.getByLabel('Total target stake (HNY)');
    await target.fill(input);
    await page.getByRole('button', { name: 'Simulate stake change' }).click();
    if (delayed) {
      await page.getByText(/A queued change would not be applied yet and may fail later/).waitFor();
      await page.getByText('0 HNY', { exact: true }).waitFor();
    } else {
      await page.getByText('Immediate path in simulation only. No stake changed.', { exact: true }).waitFor();
      await page.getByText('60.000000000000000001 HNY', { exact: true }).waitFor();
    }
    await page.getByText('This is not a withdrawal or refund quote. No signing or submission occurred.', { exact: true }).waitFor();
    assert.deepEqual(stakeRequests, [{ account, target: input, blockHash }]);
    await target.fill('10');
    assert.equal(await page.getByRole('heading', { name: 'Unsigned stake simulation' }).count(), 0);
    await page.getByLabel('Public wallet address', { exact: true }).fill('0x' + '4'.repeat(40));
    assert.equal(await page.getByRole('button', { name: 'Simulate stake change' }).count(), 0);
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => r.startsWith(url + '/')));
    console.log('PASS: mobile browser cases → jury, evidence, public ballot simulation, editing/reset, outsider, unchallenged Decision, stake (' + (delayed ? 'delayed exit' : 'immediate increase') + ') simulation, no network outside loopback fixture');
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
