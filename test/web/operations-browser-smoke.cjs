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
    const account = '0x' + '3'.repeat(40);
    const posts = [];
    page.on('request', r => { if (r.method() === 'POST') posts.push([new URL(r.url()).pathname,r.postDataJSON()]); });
    await page.getByRole('button', { name: 'Kleros cases' }).click();
    await page.getByRole('button', { name: 'Details for Conviction proposal #21' }).click();
    await page.getByRole('button', { name: 'Load settlement receipt' }).click();
    await page.getByRole('heading', { name: 'Court callback pending' }).waitFor();
    await page.getByRole('button', { name: 'Close', exact:true }).click();
    await page.getByRole('button', { name: 'Decision votes' }).click();
    await page.getByRole('button', { name: 'Details for Decision vote #0' }).click();
    await page.getByLabel('Decision voter address').fill(account);
    await page.getByLabel('Decision ballot choice').selectOption('nay');
    await page.getByRole('button', { name: 'Simulate Decision ballot' }).click();
    await page.getByRole('heading', { name: 'Unsigned Decision ballot simulation' }).waitFor();
    await page.getByLabel('Decision ballot choice').selectOption('yea');
    assert.equal(await page.getByRole('heading', { name: 'Unsigned Decision ballot simulation' }).count(),0);
    await page.getByRole('button', { name: 'Close', exact:true }).click();
    await page.getByRole('button', { name: 'My stake' }).click();
    await page.getByRole('button', { name: 'Try the demo wallet' }).click();
    const increase = process.env.HONEY_DEMO_ZERO_ALLOWANCE === '1';
    const mode = increase ? 'increase':'clear';
    await page.getByLabel('Allowance operation').selectOption(mode);
    const target = '51.000000000000000001';
    if (increase) await page.getByLabel('Desired total court stake (HNY)').fill(target);
    await page.getByRole('button', { name: 'Simulate allowance' }).click();
    await page.getByRole('heading', { name: 'Unsigned allowance simulation' }).waitFor();
    await page.getByLabel('Allowance operation').selectOption(increase ? 'clear':'increase');
    assert.equal(await page.getByRole('heading', { name: 'Unsigned allowance simulation' }).count(),0);
    assert.deepEqual(posts,[['/api/preview/decision-vote',{account,id:'0',supports:false}],
      ['/api/preview/stake-allowance',{account,mode,blockHash:'0x'+'a5'.repeat(32),...(increase?{target}:{})}]]);
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => new URL(r).origin === url));
    console.log('Decision, settlement and allowance checks passed:', mode);
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
