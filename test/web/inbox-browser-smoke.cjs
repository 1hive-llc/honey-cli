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
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM, args: ['--disable-background-networking'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(7000);
    const pageErrors = [];
    const requests = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('request', r => requests.push(r.url()));
    await page.goto(url);
    await page.getByRole('button', { name: 'My Jury inbox' }).click();
    await page.getByRole('heading', { name: 'My Jury inbox' }).waitFor();
    await page.getByRole('button', { name: 'Try the demo juror' }).click();
    await page.getByRole('heading', { name: 'Needs your vote' }).waitFor();
    await page.getByText('Vote needed', { exact: true }).waitFor();
    const assignment = page.getByRole('button', { name: 'Details for Conviction proposal #21' });
    await assignment.click();
    await page.getByRole('heading', { name: 'Orchard maintenance grant' }).waitFor();
    assert.equal(await page.getByLabel('Juror public wallet address').inputValue(), '0x' + '3'.repeat(40));
    await page.getByText('Seat 0 · Not voted', { exact: true }).waitFor();
    await page.getByText('Seat 2 · For the challenger', { exact: true }).waitFor();
    await page.getByText('ipfs://demo-evidence', { exact: true }).waitFor();
    await page.getByText('Read sample: Proposal submitter', { exact: true }).click();
    await page.getByText(/The grant pays for pruning/).waitFor();
    await page.getByText('Read sample: Challenger', { exact: true }).click();
    await page.getByText(/does not identify who authorized/).waitFor();
    assert.equal(await page.getByText('Sample evidence for this demo. Not retrieved from the reference.', { exact: true }).count(), 2);
    await page.getByLabel('Public ruling choice').selectOption('challenger');
    await page.getByLabel('Public justification').fill('Compared the demo arguments.');
    await page.getByRole('button', { name: 'Simulate public ballot' }).click();
    await page.getByRole('heading', { name: 'Unsigned ballot simulation' }).waitFor();
    assert(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert(await assignment.evaluate(el => el === document.activeElement));
    await page.route('**/api/jury/proposals/21?*', async route => {
      const response = await route.fetch();
      const json = await response.json();
      json.evidence.items[1].uri = 'ipfs://demo-not-bundled';
      await route.fulfill({ response, json });
    });
    await assignment.click();
    await page.getByText('ipfs://demo-not-bundled', { exact: true }).waitFor();
    await page.getByText('No sample is included for this submission. The recorded reference is still shown.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Read sample: Challenger', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Submitted by', { exact: true }).count(), 2);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByLabel('Inbox public wallet address').fill('0x' + '7'.repeat(40));
    await page.getByRole('button', { name: 'Find my cases' }).click();
    await page.getByText('No assignments found among the candidates on this page.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Details for Conviction proposal #21' }).count(), 0);
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => new URL(r).origin === url));
    console.log('Inbox: owner, public vote due, round seats, outsider and same-origin browser checks passed.');
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
