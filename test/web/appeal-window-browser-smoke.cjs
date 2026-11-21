const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_LOCAL || 'playwright');
(async () => {
  const fixture = spawn(process.execPath, ['--import', 'tsx', 'examples/governance/preview.ts'], {env:{...process.env,HONEY_DEMO_APPEAL:process.env.HONEY_DEMO_APPEAL || '1'}});
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
    const methods=[];
    page.on('request',r=>methods.push(r.method()));
    await page.getByRole('button',{name:'Kleros cases'}).click();
    await page.getByRole('button',{name:'Details for Conviction proposal #21'}).click();
    await page.getByRole('button',{name:'Load appeal window'}).click();
    await page.getByText('Appeal end (exclusive)',{exact:true}).waitFor();
    await page.getByText('Read only. This browser cannot fund an appeal or claim a reward.',{exact:true}).waitFor();
    await page.getByText('One choice fully funded; no new round yet from this window.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Load settlement receipt'}).click();
    await page.getByText('Only the initial court round is recorded.',{exact:true}).waitFor();
    await page.getByText('This receipt does not verify appeal-backer withdrawals or juror reward claims.',{exact:true}).waitFor();
    if (process.env.HONEY_DEMO_APPEAL==='other-token') {
      await page.getByText('Fee amounts are not shown because the fee asset is unverified.',{exact:true}).waitFor();
      assert.equal(await page.getByText('Gross funding target',{exact:true}).count(),0);
      assert.equal(await page.getByText('Base appeal cost',{exact:true}).count(),0);
    } else {
      await page.getByText('Gross targets are for the whole choice, not the remaining contribution.',{exact:true}).waitFor();
      assert.equal(await page.getByText('Gross funding target',{exact:true}).count(),3);
      for (const [n,status,open,cost] of [['Refuse to rule','Not fully funded','No','6 HNY'],['For the challenger','Not fully funded','Yes','4 HNY'],['For the submitter','Fully funded','No','6 HNY']]) {
        const row = page.getByRole('heading',{name:n,exact:true}).locator('xpath=following-sibling::*[1]');
        const texts = await row.innerText();
        assert(texts.includes(status) && texts.includes(open) && texts.includes(cost),texts);
      }
    }
    assert(methods.every(method=>method==='GET'));
    assert.deepEqual(pageErrors, []);
    assert(requests.every(r => new URL(r).origin === url));
    console.log('Appeal window: three choices, observed cutoff, verified gross target or no amount; GET only.');
  } finally {
    await browser?.close();
    if (fixture.exitCode === null && fixture.signalCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
