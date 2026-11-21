const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_LOCAL || 'playwright');
(async () => {
  const fixture = spawn(process.execPath, ['--import', 'tsx', 'examples/governance/preview.ts'], {env:{...process.env,HONEY_DEMO_ESCALATION:'1'}});
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
    const account = '0x' + '5'.repeat(40), outsider = '0x' + '3'.repeat(40);
    const posts = [];
    page.on('request', r => { if(r.method() === 'POST') posts.push([new URL(r.url()).pathname,r.postDataJSON()]); });
    await page.getByRole('button',{name:'Details for Conviction proposal #21'}).click();
    const wallet = page.getByLabel('Action submitter address');
    await wallet.fill(outsider);
    await page.getByRole('button',{name:'Load escalation quote'}).click();
    await page.getByText('This address is not verified as eligible to escalate at the quoted block.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Simulate escalation'}).count(),0);
    await wallet.fill(account);
    await page.getByRole('button',{name:'Load escalation quote'}).click();
    await page.getByRole('heading',{name:'Escalation quote'}).waitFor();
    for (const [term,value] of [['New submitter arbitration fee','3 HNY'],['Challenger fee already in escrow','2 HNY']]) {
      const field = page.getByText(term,{exact:true});
      await field.waitFor();
      assert.equal(await field.evaluate(e=>e.nextElementSibling.textContent),value);
    }
    await page.getByRole('button',{name:'Simulate escalation'}).click();
    await page.getByRole('heading',{name:'Unsigned escalation simulation'}).waitFor();
    await page.getByText('No dispute was opened. No fee was paid.',{exact:true}).waitFor();
    await wallet.fill(outsider);
    assert.equal(await page.getByRole('heading',{name:'Unsigned escalation simulation'}).count(),0);
    assert.deepEqual(posts,[['/api/preview/escalation',{kind:'proposals',id:'21',account,blockHash:'0x'+'a5'.repeat(32)}]]);
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => new URL(r).origin === url));
    console.log('Escalation: eligible submitter only, Waiting challenge, separate fresh and escrow fees; no dispute or payment.');
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
