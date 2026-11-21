const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_LOCAL || 'playwright');
(async () => {
  const fixture = spawn(process.execPath, ['--import', 'tsx', 'examples/governance/preview.ts'], {env:{...process.env,HONEY_DEMO_PARTY_EVIDENCE:'1'}});
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
    await page.getByRole('button',{name:'Kleros cases'}).click();
    await page.getByRole('button',{name:'Details for Conviction proposal #21'}).click();
    await page.getByRole('button',{name:'Try the demo juror'}).click();
    await page.getByText('Party evidence references',{exact:true}).click();
    await page.getByText('Recorded at block',{exact:true}).first().waitFor();
    await page.getByText('7654320',{exact:true}).waitFor();
    await page.getByText('ipfs://demo-evidence',{exact:true}).waitFor();
    const wallet = page.getByLabel('Party public address');
    await wallet.fill(outsider);
    await page.getByRole('button',{name:'Check evidence eligibility'}).click();
    await page.getByText(/Preview unavailable\./).first().waitFor();
    assert.equal(await page.getByRole('button',{name:'Simulate party evidence'}).count(),0);
    await wallet.fill(account);
    await page.getByRole('button',{name:'Check evidence eligibility'}).click();
    await page.getByText('Verified party',{exact:true}).waitFor();
    await page.getByText('challenger',{exact:true}).first().waitFor();
    const reference = 'Référence témoin 7';
    const field = page.getByLabel('Public evidence reference');
    await field.fill(reference);
    await page.getByRole('button',{name:'Simulate party evidence'}).click();
    await page.getByRole('heading',{name:'Unsigned party evidence simulation'}).waitFor();
    await page.getByText('No evidence was submitted and no file was uploaded.',{exact:true}).waitFor();
    await field.fill('Second note');
    assert.equal(await page.getByRole('heading',{name:'Unsigned party evidence simulation'}).count(),0);
    assert.deepEqual(posts,[['/api/preview/evidence',{kind:'proposals',id:'21',account,blockHash:'0x'+'a5'.repeat(32),reference}]]);
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => new URL(r).origin === url));
    console.log('Party evidence: metadata only, outsider denied, exact UTF-8 preview, no upload, no external fetch.');
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
