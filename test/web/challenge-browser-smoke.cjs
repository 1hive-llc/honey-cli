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
    const account = '0x' + '3'.repeat(40), outsider = '0x' + '2'.repeat(40);
    const posts = [];
    page.on('request', r => { if(r.method() === 'POST') posts.push([new URL(r.url()).pathname,r.postDataJSON()]); });
    await page.getByRole('button', {name:'Decision votes'}).click();
    await page.getByRole('button', {name:'Details for Decision vote #0'}).click();
    const wallet = page.getByLabel('Challenger public address');
    await wallet.fill(outsider);
    await page.getByRole('button', {name:'Load challenge quote'}).click();
    await page.getByText('This account is not verified as eligible to challenge at the quoted block.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button', {name:'Simulate Agreement challenge'}).count(),0);
    await wallet.fill(account);
    await page.getByRole('button', {name:'Load challenge quote'}).click();
    await page.getByRole('heading', {name:'Challenge quote'}).waitFor();
    await page.getByText('Total challenger escrow',{exact:true}).waitFor();
    await page.getByText('6 HNY',{exact:true}).first().waitFor();
    const offer = page.getByLabel('Settlement offer (HNY)');
    await offer.fill('1.000000000000000001');
    await page.getByLabel('Challenge context').fill('Public fixture rationale');
    await page.getByRole('button', {name:'Simulate Agreement challenge'}).click();
    await page.getByRole('heading', {name:'Unsigned challenge simulation'}).waitFor();
    await page.getByText('No challenge was opened. No funds were moved.',{exact:true}).waitFor();
    await offer.fill('2');
    assert.equal(await page.getByRole('heading', {name:'Unsigned challenge simulation'}).count(),0);
    assert.deepEqual(posts,[['/api/preview/challenge',{kind:'votes',id:'0',account,blockHash:'0x'+'a5'.repeat(32),
      offerHny:'1.000000000000000001',context:'Public fixture rationale'}]]);
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => new URL(r).origin === url));
    console.log('Challenge: denied and eligible wallets, fee and collateral display, exact offer, and no submission.');
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
