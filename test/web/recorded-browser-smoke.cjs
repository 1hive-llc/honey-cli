// Offline component smoke: exercise the real addJury renderer with verified query output.
// Routes are fulfilled in-process. Never opens a server or calls an RPC.
const {chromium} = require(process.env.PLAYWRIGHT_LOCAL || 'playwright');
const {mkdtempSync,readFileSync,writeFileSync,rmSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
const {join,resolve} = require('node:path');
const {tmpdir} = require('node:os');
const assert = require('node:assert/strict');
const dir=mkdtempSync(join(tmpdir(),'honey-browser-')), origin='http://honey-replay.invalid';
const checkpoints=[
  ['49330522','Before either ballot',['Seat 0 · Not voted','Seat 2 · Not voted']],
  ['49330523','First ballot',['Seat 0 · For the challenger','Seat 2 · For the challenger']],
  ['49330524','Second ballot',['Seat 1 · For the challenger']]
];
(async()=>{
  let browser;
  try {
    execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run','test/web/recorded-case.test.ts'],{
      stdio:'inherit',env:{...process.env,HONEY_REPLAY_EXPORT_DIR:dir,DOTENV_CONFIG_PATH:'/dev/null',RUN_FORK_E2E:'0'}
    });
    browser=await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM, args:['--disable-background-networking']});
    const context=await browser.newContext({serviceWorkers:'block'});
    let frame;
    const unexpected=[];
    const body='<h1>Decision #21: recorded jury replay</h1><main id="panel"></main>';
    // Append a test-only call to the existing UI module. Do not mount unrelated buttons/routes.
    const app=readFileSync('src/web/assets/app.js','utf8');
    const bootstrap=app.indexOf("for (const button of document.querySelectorAll('[data-tab]')) button.onclick");
    assert(bootstrap>0);
    await context.route('**/*',async route=>{
      const r=route.request(),u=new URL(r.url());
      if(u.origin!==origin || r.method()!=='GET'){unexpected.push(r.url());return route.abort();}
      if(u.pathname==='/') return route.fulfill({contentType:'text/html',body:body+'<script type="module" src="/jury.js"></script>'});
      if(u.pathname==='/jury.js') return route.fulfill({contentType:'application/javascript',body:app.slice(0,bootstrap)+
        '\nctx={mode:"fixture",chainId:31337}; addJury($("panel"),"votes","21",new AbortController(),'+JSON.stringify(frame.account)+');'});
      if(u.pathname==='/api/jury/votes/21' && u.searchParams.get('account')===frame.account)
        return route.fulfill({json:{mode:'fixture',chainId:31337,...frame}});
      unexpected.push(r.url());return route.abort();
    });
    const page=await context.newPage(), errors=[];
    page.setDefaultTimeout(6500);page.on('pageerror',e=>errors.push(String(e)));
    const pages=[];
    for(const [block,title,expected] of checkpoints){
      frame=JSON.parse(readFileSync(join(dir,block+'.json'),'utf8'));
      await page.goto(origin+'/');
      const list=page.locator('.jury-panel ul').first(), evidence=page.locator('details').filter({has:page.getByText('Party evidence references',{exact:true})});
      await list.waitFor();assert.deepEqual(await list.locator('li').allTextContents(),expected);
      const text=await evidence.innerText();
      for(const e of frame.evidence.items)for(const v of [e.uri,e.submitter,e.transactionHash,e.block])assert(text.includes(v));
      // Serialize the verified UI sections, not the fixture-only controls or synthetic timing.
      pages.push('<section><h2>'+title+' · block '+block+'</h2><p>Juror <code>'+frame.account+'</code></p>'+
        await list.evaluate(el=>el.outerHTML)+(frame.ballotHash?'<p>Ballot receipt: <code>'+frame.ballotHash+'</code></p>':'')+
        (pages.length===0?await evidence.evaluate(el=>el.outerHTML):'')+'</section>');
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Decision #21 jury replay</title><h1>Decision #21: recorded jury replay</h1>'+
      '<p>Local Gnosis fork · Agreement action 235 · Challenge 14 · Core dispute 0 · Round 0.</p>'+
      '<p>Three checkpoints from the same case. The CLI and browser read models were compared against receipt-derived getter projections, not captured RPC responses. Evidence references were not fetched. No wallet or connection is needed.</p>'+
      pages.join('')+'</html>';
    const dest=resolve(process.argv[2] || 'Decision-21-jury-replay.html');
    await page.setContent(html);
    for(const [,title,expected] of checkpoints){
      const section=page.locator('section').filter({has:page.getByRole('heading',{name:new RegExp('^'+title)})});
      assert.deepEqual(await section.locator('li').allTextContents(),expected);
    }
    writeFileSync(dest,html);console.log('PASS: real jury DOM at three recorded checkpoints; standalone copy at '+dest);
  }finally{await browser?.close();rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
