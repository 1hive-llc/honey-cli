const $ = id => document.getElementById(id);
const names = { proposals: 'Conviction proposals', votes: 'Decision votes', cases: 'Kleros cases', 'jury-inbox': 'My Jury inbox' };
const singular = kind => kind === 'votes' ? 'Decision vote' : 'Conviction proposal';
const chainNames = { 100: 'Gnosis', 10200: 'Chiado', 31337: 'Local fork' };
const modes = { fixture: 'Synthetic fixture', profile: 'Configured profile' };
const sources = { gardens: 'Gardens index', 'known-ids': 'Operator-listed IDs', none: 'Direct ID lookup' };
// Fictional text keyed only to the synthetic demo references.
const demoEvidence = new Map([
  ['ipfs://demo-evidence', ['Proposal submitter', 'The grant pays for pruning, irrigation repairs, and public volunteer days. The proposal includes a season budget and promises to publish receipts.']],
  ['ipfs://demo-challenge', ['Challenger', 'The budget includes irrigation repairs, but does not identify who authorized the work or who will control the equipment after the grant.']],
]);
let ctx, area = 'proposals', page = 1, result, listRequest, detailRequest;
const juryLabels = { 'vote-needed': 'Vote needed', voted: 'Action completed · voted', waiting: 'Wait', appeal: 'Appeal phase', unsupported: 'Action unavailable' };
let inboxAccount = '', selected, inlineTrigger;
const wide = matchMedia('(min-width: 1040px)');
const dialog = $('dialog');
const pane = $('record-pane');
function node(tag, value, className) {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = String(value);
  if (className) el.className = className;
  if (tag === 'button') el.classList.add('btn');
  if (tag === 'input') el.classList.add('form-control');
  if (tag === 'select') el.classList.add('form-select');
  if (tag === 'textarea') el.classList.add('form-control');
  return el;
}
function provenance(block) {
  return modes[ctx.mode] + ' · ' + (block === null ? 'Configured chain ' : 'RPC chain ') + ctx.chainId +
    (block === null ? '' : ' · RPC block ' + block);
}
async function api(path, signal, body) {
  const options = { signal, headers: { 'X-Honey-Read': '1' } };
  if (body) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api/' + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Local query unavailable.');
  return data;
}
function notice(text, warn = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('warn', warn);
}
function render() {
  const container = $('results');
  container.replaceChildren();
  if (!result) return;
  const text = $('filter').value.trim().toLowerCase();
  const filter = area === 'jury-inbox' ? '' : text;
  const rows = result.rows.filter(row =>
    (!filter || [row.id, row.title, row.state, singular(row.kind), row.court?.coreDispute].join(' ').toLowerCase().includes(filter)) &&
    (area !== 'cases' || !$('case-state').value || row.state === $('case-state').value));
  const groups = area === 'jury-inbox' ? [
    ['Needs your vote', rows.filter(row => row.status === 'vote-needed')],
    ['Other assignments', rows.filter(row => row.status !== 'vote-needed')],
  ] : [[null, rows]];
  for (const [heading, records] of groups) {
    if (heading && records.length) container.append(node('h3', heading, 'row-group'));
    for (const row of records) {
      const record = node('article', undefined, 'record');
      const label = node('div');
      const identity = singular(row.kind) + ' #' + row.id;
      if (area === 'cases' && row.court?.coreDispute != null) {
        label.append(node('small', identity), node('strong', 'Core dispute #' + row.court.coreDispute +
          (row.court.period ? ' · ' + row.court.period : '')));
      } else if (row.title) label.append(node('strong', row.title), node('small', identity));
      else label.append(node('strong', identity));
      const status = node('span', row.state, row.state === 'Unknown' ? 'state uncertain' : 'state');
      if (['Cancelled', 'Executed', 'Rejected', 'Settled'].includes(row.state)) status.classList.add('closed-state');
      if (['Disputed', 'Challenged', 'Active Kleros case'].includes(row.state)) status.classList.add('action-needed');
      if (area === 'jury-inbox') {
        status.textContent = juryLabels[row.status] ?? 'Action unavailable';
        status.classList.toggle('uncertain', row.status === 'unsupported');
        status.classList.toggle('action-needed', row.status === 'vote-needed');
        label.append(node('small', [row.period, row.roundId == null ? null : 'Round ' + row.roundId,
          row.seats.length + (row.seats.length === 1 ? ' seat' : ' seats')].filter(Boolean).join(' · ')));
      }
      const open = node('button', 'Details', 'record-open');
      open.setAttribute('aria-label', 'Details for ' + identity);
      record.dataset.recordKey = row.kind + ':' + row.id;
      open.onclick = () => openDetail(row.kind, row.id, area === 'jury-inbox' ? inboxAccount : '', row.title, open);
      record.append(label, status, open);
      container.append(record);
    }
  }
  if (rows.length === 0) {
    let message = 'No records match the filters on this page.';
    if (result.coverage === 'no-adapter') message = 'Set HONEY_WEB_ADAPTER in the startup profile to inspect linked cases.';
    else if (result.coverage === 'no-list-source') message = 'Configure a Gardens index or known record IDs. Direct ID lookup is available in the proposal and vote tabs.';
    else if (area === 'jury-inbox') message = result.coverage === 'partial' ?
      'No assignments verified on this partial page. Some assignments may be missing.' :
      'No assignments found among the candidates on this page.';
    else if (area === 'cases' && !text && $('case-state').value === 'Active Kleros case') {
      message = result.coverage === 'partial' ? 'No active cases verified on this partial page. Some candidates or index records could be missing.' :
        'No active Kleros cases found among the candidate records on this page.';
    } else if (!result.scanned) message = 'The selected source returned no records for this page.';
    container.append(node('p', message, 'empty'));
  }
  highlightRecord();
}

async function loadList() {
  if (!ctx) return;
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  result = null;
  render();
  $('section-title').textContent = area === 'proposals' ? 'Proposals' : names[area];
  $('source').textContent = {
    proposals: 'Browse funding and signaling proposals from the 1Hive community.',
    votes: 'Review governance decisions and see which votes are open.',
    cases: 'Follow Honey challenges and their linked Kleros cases.',
  }[area] || '';
  const inbox = area === 'jury-inbox';
  $('inbox-form').hidden = !inbox;
  $('inbox-demo').hidden = ctx.mode !== 'fixture';
  $('record-filters').hidden = inbox;
  if (inbox) $('source').textContent = 'See where you’re assigned and what needs your vote. This checks linked Honey cases, not the entire court. The configured RPC receives the public address.';
  $('preview').hidden = area !== 'proposals';
  $('lookup').hidden = area === 'cases';
  $('case-filter').hidden = area !== 'cases';
  $('index-filter').hidden = area === 'cases' || ctx.source !== 'gardens';
  $('page').textContent = 'Page ' + page;
  $('previous').disabled = page === 1;
  $('next').disabled = true;
  if (inbox && !inboxAccount) { notice('Enter a public wallet address to check assignments.'); return; }
  notice('Reading ' + names[area].toLowerCase() + '…');
  try {
    const search = new URLSearchParams({ page: String(page) });
    if (inbox) search.set('account', inboxAccount);
    else if (!$('index-filter').hidden && $('indexed-state').value) search.set('state', $('indexed-state').value);
    const data = await api(area + '?' + search, request.signal);
    if (request.signal.aborted) return;
    result = data;
    $('next').disabled = !result.hasNext || page >= 99999;
    if (data.coverage === 'no-adapter') notice('No Kleros adapter configured. Case coverage is unavailable.', true);
    else if (data.coverage === 'no-list-source') notice('No list source configured.', true);
    else {
      const coverage = [provenance(data.block)];
      if (inbox) {
        coverage.push(data.scanned + ' candidates checked', data.rows.length + ' assigned cases on this page');
        if (data.coverage === 'partial') coverage.push('Partial coverage: some assignments may be missing');
      } else if (area === 'cases') {
        const active = data.rows.filter(r => r.state === 'Active Kleros case').length;
        const pending = data.rows.filter(r => r.state === 'Awaiting Agreement resolution').length;
        coverage.push(data.scanned + (data.scanned === 1 ? ' candidate' : ' candidates') + ' on this page', active + ' active', pending + ' awaiting Agreement resolution');
      } else coverage.push(data.scanned + (data.scanned === 1 ? ' record' : ' records') + ' on this page');
      if (data.unknown) coverage.push('Partial results · ' + data.unknown + ' unknown');
      if (data.hasNext) coverage.push('More candidates available');
      if (ctx.source === 'gardens') coverage.push(data.indexBlock == null ? 'Index block unavailable' : 'Index block ' + data.indexBlock);
      if (data.indexingErrors) coverage.push('Partial results · Index reports indexing errors');
      notice(coverage.join(' · '), data.coverage === 'partial');
    }
    render();
    if (area === 'proposals' && wide.matches && !dialog.open && !$('filter').value && page === 1 && !selected && data.rows.length) {
      const first = data.rows[0];
      openDetail(first.kind, first.id, '', first.title, null, false);
    }
  } catch (err) {
    if (!request.signal.aborted) notice('Query unavailable. ' + err.message, true);
  }
}

function showDialog(title, inline = false, focus = true) {
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  if (dialog.open && dialog.classList.contains('inline') !== inline) dialog.close();
  dialog.classList.toggle('inline', inline);
  if (inline && dialog.parentElement !== pane) pane.append(dialog);
  if (!inline && dialog.parentElement !== document.body) document.body.append(dialog);
  $('dialog-title').textContent = title;
  $('detail').replaceChildren();
  if (!dialog.open) {
    if (inline) dialog.show();
    else dialog.showModal();
  }
  if (focus) $('dialog-title').focus();
  else if (inline && dialog.contains(document.activeElement)) document.activeElement.blur();
  return request;
}

function highlightRecord() {
  for (const row of $('results').querySelectorAll('.record'))
    row.classList.toggle('selected', row.dataset.recordKey === selected && dialog.open && dialog.classList.contains('inline'));
}

function fields(entries) {
  const list = node('dl');
  for (const [k, v] of entries) list.append(node('dt', k), node('dd', v ?? 'Unavailable'));
  return list;
}
function labeledFields(obj) {
  return Object.entries(obj).filter(([,value]) => typeof value !== 'object').map(([k,v]) => {
    const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
    return [label, v];
  });
}
function command(container, label, value) {
  const box = node('div', undefined, 'command');
  const code = node('code', value);
  const copy = node('button', 'Copy command');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(value); copy.textContent = 'Copied'; }
    catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      copy.textContent = 'Selected · copy with keyboard';
    }
  };
  box.append(node('strong', label), code, copy);
  container.append(box);
}
function nextSteps(container, d) {
  const group = node('details');
  group.append(node('summary', 'CLI next steps'));
  group.append(node('p', 'Run from the Honey CLI checkout. Set HONEY_PROFILE to the same local profile. Builder commands need a public ACTOR address. These examples have not been executed.'));
  const base = 'DOTENV_CONFIG_PATH="${HONEY_PROFILE:?set HONEY_PROFILE}" DOTENV_CONFIG_OVERRIDE=true node bin/honey.mjs ';
  const flags = ' --chain ' + ctx.chainId + ' --json';
  const prefix = d.kind === 'votes' ? 'decisions' : 'proposals';
  const select = d.kind === 'votes' ? '--vote ' : '--proposal ';
  command(group, 'Read app state', base + prefix + ' show ' + d.id + flags);
  command(group, 'Check ruling, resolution and finality', base + 'disputes status ' + select + d.id +
    (ctx.adapter ? ' --adapter ' + ctx.adapter : '') + flags);
  if (d.court.actionId && !d.court.closed && d.court.challengeState === 'Unchallenged') {
    group.append(node('p', 'A challenge can lock challenger collateral and incur dispute costs.', 'warning'));
    command(group, 'Build a challenge preview', base + 'disputes challenge ' + d.court.actionId +
      ' --from "${ACTOR:?set ACTOR}" --settlement-offer 0 --evidence "${EVIDENCE:?set EVIDENCE}"' + flags);
  }
  if ((d.kind === 'proposals' && d.data.open) || (d.kind === 'votes' && d.data.canExecute)) {
    const script = d.kind === 'votes' ? ' --execution-script "${EXECUTION_SCRIPT:?set reviewed EXECUTION_SCRIPT}"' : '';
    command(group, 'Simulate app execution', base + prefix + ' execute ' + d.id + script + ' --from "${ACTOR:?set ACTOR}"' + flags);
  }
  group.append(node('p', 'The CLI has unsigned court finalization and Agreement resolution previews. This browser does not submit them.'));
  container.append(group);
}
function addJury(container, kind, id, request, initialAccount) {
  const panel = node('section', undefined, 'jury-panel');
  const load = node('form');
  const accountLabel = node('label', 'Juror public wallet address');
  const account = node('input');
  account.value = initialAccount || '';
  account.required = true;
  account.pattern = '0x[0-9a-fA-F]{40}';
  account.maxLength = 42;
  account.autocomplete = 'off';
  account.spellcheck = false;
  account.placeholder = '0x…';
  accountLabel.append(account);
  load.className = 'wallet-form';
  load.append(accountLabel, node('button', 'Load my seats', 'primary'));
  const status = node('p');
  status.setAttribute('role', 'status');
  const contents = node('div');
  panel.append(node('h3', 'My Jury'), node('p', 'Check seats and evidence for this case. The configured RPC receives the public address; no wallet is connected.'), status, contents);
  if (initialAccount) {
    const wallet = node('details', undefined, 'wallet-switch');
    wallet.append(node('summary', 'Change public wallet'), load);
    panel.append(wallet);
  } else panel.insertBefore(load, status);
  container.append(panel);
  if (ctx.mode === 'fixture') {
    const sample = node('button', 'Try the demo juror');
    sample.type = 'button';
    sample.onclick = () => { account.value = '0x3333333333333333333333333333333333333333'; load.requestSubmit(); };
    load.append(sample);
  }
  let generation = 0;
  const current = (turn, address) => !request.signal.aborted && turn === generation && account.value.trim() === address;
  account.oninput = () => {
    generation++;
    account.setCustomValidity('');
    status.textContent = '';
    contents.replaceChildren();
  };
  load.onsubmit = async event => {
    event.preventDefault();
    const address = account.value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      account.setCustomValidity('Enter a nonzero public wallet address.');
      account.reportValidity();
      return;
    }
    const turn = ++generation;
    status.textContent = 'Reading court assignment and evidence…';
    contents.replaceChildren();
    try {
      const d = await api('jury/' + kind + '/' + encodeURIComponent(id) + '?account=' + encodeURIComponent(address), request.signal);
      if (!current(turn, address)) return;
      const j = d.jury;
      if (!j || d.mode !== ctx.mode || d.chainId !== ctx.chainId || d.block == null) throw new Error('No same-chain jury observation was returned.');
      status.textContent = '';
      const seats = Array.isArray(j.seats) ? j.seats : [];
      const meta = node('details');
      meta.append(node('summary', 'Round and timing'), node('p', provenance(d.block), 'record-id'),
        fields([['Round', j.roundId], ['Period', j.period], ['Voting mode', j.hiddenVotes ? 'Hidden ballot' : 'Public ballot'],
          ['Paused', j.paused ? 'Yes' : 'No'], ['Owned seats', seats.length]]));
      const list = node('ul');
      const rulings = ['Refused to rule', 'For the challenger', 'For the submitter'];
      if (d.timing) {
        const t = d.timing;
        meta.append(node('h4', 'Period timing'), node('p', t.transition));
        if (t.status === 'available' && t.timeThreshold != null) {
          const date = new Date(Number(t.timeThreshold) * 1000);
          const when = Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : t.timeThreshold + ' (Unix seconds)';
          meta.append(fields([['Earliest time-based threshold', when]]),
            node('p', 'Not a voting deadline. A phase can become eligible earlier, and it changes only when a transaction advances it on-chain.'));
        }
        if (Array.isArray(t.fundedChoices)) {
          meta.append(fields([['Fully funded choices', t.fundedChoices.length ?
            t.fundedChoices.map(id => rulings[Number(id)] ?? 'Choice ' + id).join(', ') : 'None at this block']]));
        }
        if (j.period === 'appeal') meta.append(node('p', 'Appeal funding is not available in this browser.'));
      }
      for (const seat of seats) {
        const ruling = seat.choice == null ? null : rulings[Number(seat.choice)];
        list.append(node('li', 'Seat ' + seat.voteId + ' · ' + (seat.voted ? ruling ?? 'Voted' : 'Not voted')));
      }
      if (seats.length) contents.append(node('h4', 'Your seats'), list);
      else contents.append(node('p', 'No owned seats were returned for this wallet in this round.'));
      const evidence = node('details');
      evidence.append(node('summary', 'Party evidence references'));
      const items = Array.isArray(d.evidence?.items) ? d.evidence.items : [];
      if (d.evidence?.status === 'not-configured') evidence.append(node('p', 'Evidence lookup is not configured.'));
      else if (d.evidence?.status !== 'complete') evidence.append(node('p', 'Evidence lookup is unavailable. This does not establish that no evidence exists.'));
      else if (!items.length) evidence.append(node('p', 'No adapter evidence references were returned for the observed range.'));
      if (items.length) evidence.append(node('p', 'A recorded reference does not establish that a file exists or is accessible. No file has been fetched.'));
      for (const item of items) {
        const entries = [['Submitted by', item.submitter], ['Reference (not fetched)', item.uri || 'Missing'], ['Transaction hash', item.transactionHash]];
        if (item.block != null) entries.push(['Recorded at block', item.block]);
        evidence.append(fields(entries));
        if (ctx.mode === 'fixture') {
          const sample = demoEvidence.get(item.uri);
          if (sample) {
            const preview = node('details');
            preview.append(node('summary', 'Read sample: ' + sample[0]),
              node('p', 'Sample evidence for this demo. Not retrieved from the reference.'), node('p', sample[1]));
            evidence.append(preview);
          } else evidence.append(node('p', 'No sample is included for this submission. The recorded reference is still shown.'));
        }
      }
      contents.append(evidence);
      if (initialAccount && items.length) evidence.open = true;
      const available = seats.filter(s => s.voted === false && /^\d+$/.test(s.voteId));
      if (j.canPreview !== true || j.period !== 'vote' || j.hiddenVotes !== false || j.paused !== false || !available.length ||
          typeof j.roundId !== 'string' || !/^\d+$/.test(j.roundId)) {
        contents.append(node('p', 'Ballot preview unavailable. It requires an unpaused public voting round and at least one unvoted seat owned by this wallet.'));
      } else addJuryPreview(contents, { kind, id, address, j, available, turn, current, request });
      contents.append(meta);
    } catch (err) {
      if (current(turn, address)) status.textContent = 'Jury details unavailable. ' + err.message;
    }
  };
  if (initialAccount) load.requestSubmit();
}

function addJuryPreview(container, { kind, id, address, j, available, turn, current, request }) {
  const form = node('form');
  const seatGroup = node('fieldset');
  seatGroup.append(node('legend', 'Choose owned, unvoted seats'));
  const checks = available.map(seat => {
    const label = node('label', undefined, 'check');
    const input = node('input');
    input.type = 'checkbox';
    input.value = seat.voteId;
    input.checked = true;
    label.append(input, node('span', 'Seat ' + seat.voteId));
    seatGroup.append(label);
    return input;
  });
  const choiceLabel = node('label', 'Public ruling choice');
  const choice = node('select');
  choice.required = true;
  for (const [value, label] of [['', 'Choose a ruling'], ['refuse', 'Refuse to rule'], ['challenger', 'For the challenger'], ['submitter', 'For the submitter']]) {
    const option = node('option', label);
    option.value = value;
    choice.append(option);
  }
  choiceLabel.append(choice);
  const noteLabel = node('label', 'Public justification');
  const justification = node('textarea');
  justification.maxLength = 500;
  justification.rows = 3;
  noteLabel.append(justification);
  const submit = node('button', 'Simulate public ballot', 'primary');
  const output = node('div');
  output.setAttribute('role', 'status');
  form.append(seatGroup, choiceLabel, noteLabel, node('p', 'Preview only. The configured RPC receives these public fields. Nothing is signed or submitted.'), submit);
  container.append(form, output);
  let pending = false;
  let revision = 0;
  form.oninput = () => { revision++; output.replaceChildren(); };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!current(turn, address) || pending) return;
    const voteIds = checks.filter(check => check.checked).map(check => check.value);
    if (!voteIds.length || !['refuse', 'challenger', 'submitter'].includes(choice.value)) {
      output.textContent = 'Choose at least one seat and a ruling.';
      return;
    }
    pending = true;
    submit.disabled = true;
    const inputRevision = revision;
    output.textContent = 'Simulating unsigned ballot…';
    try {
      const d = await api('preview/jury', request.signal, {
        kind, id, account: address, roundId: j.roundId, voteIds,
        choice: choice.value, justification: justification.value.trim(),
      });
      if (!current(turn, address) || revision !== inputRevision) return;
      output.replaceChildren(node('h4', 'Unsigned ballot simulation'), fields([['Result', d.simulation], ['Method', d.method], ['Actor', d.from],
        ['Target', d.to], ['Observed block', d.block], ['Round', d.roundId]]));
    } catch (err) {
      if (current(turn, address) && revision === inputRevision) output.textContent = 'Ballot preview unavailable. ' + err.message;
    } finally {
      pending = false;
      if (current(turn, address)) submit.disabled = false;
    }
  };
}

async function openDetail(kind, id, initialAccount = '', title, trigger, focus = true) {
  const identity = singular(kind) + ' #' + id;
  selected = kind + ':' + id;
  inlineTrigger = trigger;
  const request = showDialog(title || identity, wide.matches, focus);
  highlightRecord();
  const detail = $('detail');
  detail.textContent = 'Reading app and Agreement records…';
  try {
    const d = await api(kind + '/' + id, request.signal);
    if (request.signal.aborted) return;
    const data = d.data, c = d.court;
    const summary = node('section', undefined, 'case-summary');
    summary.append(node('p', identity, 'record-id'), node('p', c.state, 'summary-title'));
    if (c.state === 'Active Kleros case' && c.period)
      summary.append(node('p', c.period === 'vote' ? 'The court is voting. Jurors can check their seats below.' :
        'Current court phase: ' + c.period + '.'));
    summary.append(node('p', (kind === 'votes' ? 'Vote state: ' : 'Proposal state: ') + data.status, 'record-id'));
    detail.replaceChildren(summary);
    if (c.state === 'Active Kleros case' && c.courtKind === 'configured-kleros-adapter') {
      const timeline = node('ol', undefined, 'case-timeline');
      timeline.append(node('li', kind === 'votes' ? 'Decision vote opened' : 'Proposal opened'), node('li', 'Challenge escalated to Kleros'));
      const current = node('li', c.period === 'vote' ? 'Jury voting' : 'Court phase: ' + (c.period || 'unavailable'));
      current.setAttribute('aria-current', 'step');
      timeline.append(current);
      detail.append(timeline);
      if (!initialAccount) {
        const jump = node('button', 'View jury assignment', 'primary');
        jump.onclick = () => detail.querySelector('.wallet-form input')?.focus();
        detail.append(jump);
      }
    }
    const technical = node('details', undefined, 'technical');
    technical.append(node('summary', 'Record and court details'), node('p', provenance(d.block)),
      node('h3', 'App state'), fields([['App address', d.app]]));
    if (kind === 'proposals') {
      technical.append(fields([['State', data.status], ['Requested amount (base units)', data.requestedAmount],
        ['Stable request', data.stableRequestAmount], ['Staked tokens (base units)', data.stakedTokens],
        ['Beneficiary', data.beneficiary], ['Submitter', data.submitter], ['Last update block', data.blockLast],
        ['Conviction at last update', data.convictionLast], ['Threshold', data.threshold]]));
    } else technical.append(fields([['State', data.status], ['Open for voting', data.isOpenForVoting], ['Can execute', data.canExecute],
      ['Yea (base units)', data.yea], ['Nay (base units)', data.nay], ['Total power (base units)', data.totalPower],
      ['Snapshot block', data.snapshotBlock], ['Execution script hash', data.executionScriptHash]]));
    technical.append(node('h3', 'Agreement & court'), node('p', c.state + (c.reason ? ' · ' + c.reason : '')));
    if (c.actionId) {
      const entries = [['Agreement', c.agreement], ['Action ID', c.actionId], ['Action closed', c.closed],
        ['Saved setting', c.setting], ['Arbitrator', c.arbitrator], ['Court identification', c.courtKind], ['Challenge state', c.challengeState]];
      if (c.challenge !== null) entries.push(['Challenge ID', c.challenge]);
      if (c.dispute !== null) entries.push(['Agreement dispute ID', c.dispute], ['Agreement ruling', c.agreementRuling]);
      if (c.core) entries.push(['Core', c.core], ['Core dispute ID', c.coreDispute], ['Court ID', c.courtId], ['Core period', c.period],
        ['Core ruled', c.coreRuled], ['Adapter finalised', c.adapterFinalised], ['Adapter ruling', c.adapterRuling]);
      technical.append(fields(entries));
    }
    if (initialAccount) addJury(detail, kind, id, request, initialAccount);
    if (kind === 'votes') {
      const settings = node('details');
      settings.append(node('summary', 'Voting settings (contract units)'), fields(labeledFields(data.setting)));
      detail.append(settings);
      if (ctx.localSimulation === true && data.status === 'Normal' && data.isOpenForVoting === true) {
        localPreview(detail, 'decision-form', request, () => true, async form => {
          const account = form.elements.account.value, supports = form.elements.choice.value === 'yea';
          const d = await api('preview/decision-vote', request.signal, { id, account, supports });
          if (d.id !== id || d.account?.toLowerCase() !== account.toLowerCase() || d.supports !== supports ||
              d.simulation !== 'success' || d.submitted !== false) throw new Error('No matching unsigned Decision ballot returned.');
          return [node('h4', 'Unsigned Decision ballot simulation'), fields([['Decision vote', '#' + id],
            ['Voter', d.account], ['Choice', supports ? 'Yea' : 'Nay']]), node('p', 'Simulation succeeded. No vote was cast.')];
        });
      }
    }
    if (ctx.localSimulation === true && c.courtKind === 'configured-kleros-adapter' && ctx.adapter &&
        c.arbitrator?.toLowerCase() === ctx.adapter.toLowerCase() && c.state === 'No challenge' && c.closed === false &&
        c.challenge === null && (kind === 'proposals' ? data.status === 'Active' : data.status === 'Normal')) {
      addChallenge(detail, kind, id, c.actionId, request);
    }
    if (ctx.localSimulation === true && ctx.adapter && c.courtKind === 'configured-kleros-adapter' &&
        c.arbitrator?.toLowerCase() === ctx.adapter.toLowerCase() && c.closed === false && c.challengeActive === true &&
        c.challengeState === 'Waiting' && c.challenge != null && c.dispute === null) {
      addEscalation(detail, kind, id, c, request);
    }
    const courtActions = node('div');
    if (c.courtKind === 'configured-kleros-adapter' && c.core && c.coreDispute != null) {
      if (ctx.localSimulation === true && ctx.adapter && c.arbitrator?.toLowerCase() === ctx.adapter.toLowerCase() &&
          c.state === 'Active Kleros case' && c.challengeState === 'Disputed' && c.closed === false) {
        addPartyEvidence(courtActions, kind, id, c.actionId, request);
      }
      if (c.state === 'Active Kleros case' && c.period === 'appeal' && c.challengeState === 'Disputed' &&
          c.closed === false && ctx.adapter && c.arbitrator?.toLowerCase() === ctx.adapter.toLowerCase()) addAppealWindow(detail, kind, id, request);
      addSettlement(courtActions, kind, id, request);
    }
    if (!initialAccount) addJury(detail, kind, id, request, initialAccount);
    detail.append(courtActions, technical);
    nextSteps(detail, d);
  } catch (err) {
    if (!request.signal.aborted) detail.textContent = 'Record unavailable. ' + err.message;
  }
}

function addEscalation(container, kind, id, court, request) {
  localPreview(container, 'escalation-quote', request, () => true, async quoteForm => {
    const account = quoteForm.elements.account.value;
    const q = await api('escalation/' + kind + '/' + encodeURIComponent(id) + '?account=' + encodeURIComponent(account), request.signal);
    const amounts = ['challengerFeeEscrowRaw', 'submitterFeeRaw', 'balanceRaw', 'allowanceRaw'];
    if (q.kind !== kind || q.id !== id || q.actionId !== court.actionId || q.challengeId !== court.challenge ||
        q.account?.toLowerCase() !== account.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(q.blockHash) ||
        !/^\d+$/.test(q.deadline) || !amounts.every(k => formatStake(q[k]) !== 'Unavailable'))
      throw new Error('No matching escalation quote returned.');
    const quote = node('div'), deadline = new Date(Number(q.deadline) * 1000);
    quote.append(node('h4', 'Escalation quote'), fields([['Challenge deadline', Number.isFinite(deadline.getTime()) ?
      deadline.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : q.deadline + ' (Unix seconds)'],
      ['New submitter arbitration fee', formatStake(q.submitterFeeRaw)], ['Challenger fee already in escrow', formatStake(q.challengerFeeEscrowRaw)],
      ['Wallet balance', formatStake(q.balanceRaw)], ['Agreement allowance', formatStake(q.allowanceRaw)], ['Observation block hash', q.blockHash]]),
      node('p', 'The challenger’s recorded fee is separate from collateral. It is not charged again to the submitter.'));
    if (q.eligible !== true) {
      quote.append(node('p', 'This address is not verified as eligible to escalate at the quoted block.'));
      return [quote];
    }
    localPreview(quote, 'escalation-form', request, () => quote.isConnected && quoteForm.elements.account.value === account, async () => {
      const d = await api('preview/escalation', request.signal, { kind, id, account, blockHash: q.blockHash });
      if (d.submitted !== false || d.eligible !== true || d.kind !== kind || d.id !== id || d.actionId !== q.actionId ||
          d.challengeId !== q.challengeId || d.deadline !== q.deadline || d.account?.toLowerCase() !== account.toLowerCase() ||
          d.blockHash !== q.blockHash || !amounts.every(k => d[k] === q[k])) throw new Error('No matching unsigned escalation returned. Load a new quote.');
      return [node('h4', 'Unsigned escalation simulation'), fields([['Simulated submitter fee', formatStake(d.submitterFeeRaw)]]),
        node('p', 'No dispute was opened. No fee was paid.')];
    });
    return [quote];
  });
}

function addPartyEvidence(container, kind, id, actionId, request) {
  localPreview(container, 'evidence-party', request, () => true, async partyForm => {
    const account = partyForm.elements.account.value;
    const q = await api('evidence/' + kind + '/' + encodeURIComponent(id) + '?account=' + encodeURIComponent(account), request.signal);
    if (q.kind !== kind || q.id !== id || q.actionId !== actionId || q.account?.toLowerCase() !== account.toLowerCase() ||
        !/^0x[0-9a-fA-F]{64}$/.test(q.blockHash) || !['submitter', 'challenger'].includes(q.role) || !['evidence', 'commit', 'vote', 'appeal', 'execution'].includes(q.period))
      throw new Error('Party eligibility was not verified for this dispute.');
    const quote = node('div');
    quote.append(fields([['Verified party', q.role], ['Observed court period', q.period], ['Observation block hash', q.blockHash]]));
    if (q.period === 'appeal') quote.append(node('p', 'Recording a reference during appeal does not mean jurors will review it.'));
    localPreview(quote, 'evidence-form', request, () => quote.isConnected && partyForm.elements.account.value === account, async form => {
      const reference = form.elements.reference.value;
      const byteLength = new TextEncoder().encode(reference).length;
      if (!reference || reference !== reference.trim() || reference.length > 500 || byteLength > 1024) throw new Error('Enter up to 500 characters and 1024 UTF-8 bytes without leading or trailing spaces.');
      const d = await api('preview/evidence', request.signal, { kind, id, account, blockHash: q.blockHash, reference });
      if (d.submitted !== false || d.kind !== kind || d.id !== id || d.actionId !== actionId || d.blockHash !== q.blockHash ||
          d.account?.toLowerCase() !== account.toLowerCase() || d.role !== q.role || d.period !== q.period || d.byteLength !== byteLength)
        throw new Error('No matching unsigned evidence preview returned. Check eligibility again.');
      return [node('h4', 'Unsigned party evidence simulation'), fields([['Reference size (bytes)', d.byteLength]]),
        node('p', 'No evidence was submitted and no file was uploaded.')];
    });
    return [quote];
  });
}

function addChallenge(container, kind, id, actionId, request) {
  localPreview(container, 'challenge-quote', request, () => true, async quoteForm => {
    const account = quoteForm.elements.account.value;
    const q = await api('challenge/' + kind + '/' + encodeURIComponent(id) + '?account=' + encodeURIComponent(account), request.signal);
    const amounts = ['challengerCollateralRaw', 'arbitratorFeeRaw', 'totalDebitRaw', 'maximumOfferRaw', 'allowanceRaw', 'balanceRaw'];
    if (q.kind !== kind || q.id !== id || q.actionId !== actionId || q.account?.toLowerCase() !== account.toLowerCase() ||
        !/^0x[0-9a-fA-F]{64}$/.test(q.blockHash) || !amounts.every(key => formatStake(q[key]) !== 'Unavailable'))
      throw new Error('No matching challenge quote returned.');
    const quote = node('div');
    quote.append(node('h4', 'Challenge quote'), fields([['Challenger collateral', formatStake(q.challengerCollateralRaw)],
      ['Arbitrator fee', formatStake(q.arbitratorFeeRaw)], ['Total challenger escrow', formatStake(q.totalDebitRaw)],
      ['Maximum settlement offer', formatStake(q.maximumOfferRaw)], ['Wallet balance', formatStake(q.balanceRaw)],
      ['Agreement allowance', formatStake(q.allowanceRaw)], ['Observation block hash', q.blockHash]]));
    if (q.eligible !== true) {
      quote.append(node('p', 'This account is not verified as eligible to challenge at the quoted block.'));
      return [quote];
    }
    localPreview(quote, 'challenge-form', request, () => quote.isConnected && quoteForm.elements.account.value === account, async form => {
      const offerHny = form.elements.offerHny.value;
      const context = form.elements.context.value.trim();
      if (!context || context.length > 500 || new TextEncoder().encode(context).length > 1024)
        throw new Error('Enter public context of up to 500 characters and 1024 UTF-8 bytes.');
      const [whole, fraction = ''] = offerHny.split('.');
      const offer = BigInt(whole + fraction.padEnd(18, '0'));
      if (offer > BigInt(q.maximumOfferRaw)) throw new Error('The offer exceeds the submitter’s locked collateral.');
      const d = await api('preview/challenge', request.signal, { kind, id, account, blockHash: q.blockHash, offerHny, context });
      if (d.submitted !== false || d.kind !== kind || d.id !== id || d.actionId !== actionId ||
          d.account?.toLowerCase() !== account.toLowerCase() || d.blockHash !== q.blockHash ||
          !amounts.every(key => q[key] === d[key]) || d.settlementOfferRaw !== String(offer))
        throw new Error('No matching unsigned challenge returned. Load a new quote.');
      return [node('h4', 'Unsigned challenge simulation'), fields([['Proposed settlement', formatStake(d.settlementOfferRaw)],
        ['Total challenger escrow', formatStake(d.totalDebitRaw)]]), node('p', 'No challenge was opened. No funds were moved.')];
    });
    return [quote];
  });
}

function utcSeconds(seconds) {
  if (seconds == null || !/^\d+$/.test(String(seconds))) return 'Unavailable';
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : seconds + ' (Unix seconds)';
}

function addAppealWindow(container, kind, id, request) {
  const button = node('button', 'Load appeal window');
  const output = node('div');
  output.setAttribute('role', 'status');
  container.append(node('h3', 'Appeal window'), button, output);
  button.onclick = async () => {
    button.disabled = true;
    output.textContent = 'Reading appeal window…';
    try {
      const d = await api('appeal/' + kind + '/' + encodeURIComponent(id), request.signal);
      if (request.signal.aborted) return;
      const names = ['Refuse to rule', 'For the challenger', 'For the submitter'];
      if (d.kind !== kind || d.id !== id || d.block == null || !Array.isArray(d.choices) || d.choices.length !== 3 ||
          new Set(d.choices.map(c => c.choice)).size !== 3 || !d.choices.every(c => ['0', '1', '2'].includes(c.choice) &&
            typeof c.funded === 'boolean' && (c.open === null || typeof c.open === 'boolean')) || d.choices.filter(c => c.funded).length > 1) throw new Error('No verified appeal window returned.');
      const fundedCount = d.choices.filter(c => c.funded).length;
      const entries = [['Funding toward another round', fundedCount === 1 ? 'One choice fully funded; no new round yet from this window.' :
        'No choice fully funded in this window.'], ['Round index (starts at zero)', d.roundId], ['Observed at', utcSeconds(d.observedAt)], ['Appeal start', utcSeconds(d.start)],
        ['Appeal end (exclusive)', utcSeconds(d.end)], ['Arbitration paused', d.paused ? 'Yes' : 'No'],
        ['Preliminary ruling', d.tied ? 'Tied' : names[d.preliminaryChoice] ?? 'Unavailable']];
      if (d.feeAsset === 'HNY' && d.baseCostRaw != null) entries.push(['Base appeal cost', formatStake(d.baseCostRaw)]);
      output.replaceChildren(node('p', provenance(d.block)), fields(entries),
        node('p', 'Each cutoff is exclusive. The window and funded states are observations at this block, not a live countdown or proof that a contribution would succeed.'));
      for (const c of d.choices) {
        const row = [['Funding status', c.funded ? 'Fully funded' : 'Not fully funded'], ['Choice window open at observed block', c.open === null ? 'Unavailable' : c.open ? 'Yes' : 'No'],
          ['Choice cutoff (exclusive)', utcSeconds(c.cutoff)]];
        if (d.feeAsset === 'HNY' && c.targetRaw != null) row.push(['Gross funding target', formatStake(c.targetRaw)]);
        output.append(node('h4', names[c.choice]), fields(row));
      }
      output.append(node('p', d.feeAsset === 'HNY' ? (d.baseCostRaw == null ? 'The HNY cost for this appeal is unavailable.' : 'Gross targets are for the whole choice, not the remaining contribution.') :
        'Fee amounts are not shown because the fee asset is unverified.'), node('p', 'Read only. This browser cannot fund an appeal or claim a reward.'));
    } catch (err) { if (!request.signal.aborted) output.textContent = 'Appeal window unavailable. ' + err.message; }
    finally { button.disabled = false; }
  };
}

function addSettlement(container, kind, id, request) {
  const button = node('button', 'Load settlement receipt');
  const output = node('div');
  output.setAttribute('role', 'status');
  container.append(node('h3', 'Settlement'), button, output);
  button.onclick = async () => {
    button.disabled = true;
    output.textContent = 'Reading court and Agreement records…';
    try {
      const d = await api('settlement/' + kind + '/' + encodeURIComponent(id), request.signal);
      if (request.signal.aborted) return;
      const r = d.receipt;
      const stage = { 'before-callback': 'Court callback pending', 'awaiting-agreement': 'Awaiting Agreement resolution',
        'agreement-resolved': 'Agreement resolution recorded' }[r?.stage];
      if (!stage || d.block == null) throw new Error('No verified settlement stage was returned.');
      output.replaceChildren(node('h4', stage), node('p', provenance(d.block)), fields([['Core ruling (code)', r.coreRuling ?? 'Not recorded'],
        ['Adapter ruling (code)', r.adapterRuling ?? 'Not recorded'], ['Applied Agreement ruling (code)', r.appliedAgreementRuling ?? 'Not recorded'],
        ['Agreement action closed', r.actionClosed === true ? 'Yes' : r.actionClosed === false ? 'No' : 'Unknown']]));
      const n = r.roundCount;
      output.append(node('p', n === '1' ? 'Only the initial court round is recorded.' :
        typeof n === 'string' && /^[1-9][0-9]*$/.test(n) ? 'An appeal round opened. Court rounds recorded: ' + n + '.' : 'Court round count unavailable.'));
      if (r.coreRuling != null) {
        const outcome = { '0': 'refused to rule', '1': 'favored the challenger', '2': 'favored the submitter' }[r.coreRuling];
        if (outcome) output.append(node('p', 'The court ' + outcome + '. ' + (r.stage === 'agreement-resolved' ?
          'Honey Agreement applied that ruling.' : 'Honey Agreement has not applied that ruling yet.')));
      }
      output.append(node('p', 'This receipt does not verify appeal-backer withdrawals or juror reward claims.'));
      const a = r.amounts;
      if (a) output.append(node('h4', 'Recorded collateral and fees'), fields([['Collateral token', a.collateralToken],
        ['Action collateral (base units)', a.actionCollateralRaw], ['Challenge collateral (base units)', a.challengeCollateralRaw],
        ['Submitter fee token', a.submitterFeeToken], ['Submitter fee (base units)', a.submitterFeeRaw],
        ['Challenger fee token', a.challengerFeeToken], ['Challenger fee (base units)', a.challengerFeeRaw]]),
        node('p', 'These are recorded amounts, not balances, transfers or payouts.'));
      else output.append(node('p', 'Recorded collateral and fee amounts are unavailable.'));
    } catch (err) { if (!request.signal.aborted) output.textContent = 'Settlement receipt unavailable. ' + err.message; }
    finally { button.disabled = false; }
  };
}

function localPreview(container, template, request, current, simulate) {
  const panel = node('section', undefined, 'jury-panel');
  panel.append($(template).content.cloneNode(true));
  container.append(panel);
  const form = panel.querySelector('form'), output = panel.querySelector('[role="status"]'), button = form.querySelector('button');
  let revision = 0;
  form.oninput = form.onchange = () => { revision++; output.replaceChildren(); };
  form.onsubmit = async event => {
    event.preventDefault();
    if (button.disabled || !current() || request.signal.aborted) return;
    const turn = ++revision;
    const valid = () => !request.signal.aborted && current() && turn === revision;
    button.disabled = true;
    output.textContent = template.endsWith('-quote') ? 'Reading quote…' : template === 'evidence-party' ? 'Checking party eligibility…' : 'Simulating…';
    try {
      const result = await simulate(form);
      if (valid()) output.replaceChildren(...result);
    } catch (err) { if (valid()) output.textContent = 'Preview unavailable. ' + err.message; }
    finally { button.disabled = false; }
  };
  return form;
}

function formatStake(raw) {
  if (typeof raw !== 'string' || !/^\d{1,78}$/.test(raw)) return 'Unavailable';
  const digits = raw.padStart(19, '0');
  const whole = digits.slice(0, -18).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '') + ' HNY';
}
function openStake() {
  const request = showDialog('My stake');
  const detail = $('detail');
  const readForm = node('form');
  const walletLabel = node('label', 'Public wallet address');
  const wallet = node('input');
  wallet.required = true;
  wallet.pattern = '0x[0-9a-fA-F]{40}';
  wallet.maxLength = 42;
  wallet.autocomplete = 'off';
  wallet.spellcheck = false;
  walletLabel.append(wallet);
  readForm.append(walletLabel, node('button', 'Load stake position'));
  if (ctx.mode === 'fixture') {
    const demo = node('button', 'Try the demo wallet');
    demo.type = 'button';
    demo.onclick = () => {
      wallet.value = '0x3333333333333333333333333333333333333333';
      wallet.setCustomValidity('');
      readForm.requestSubmit();
    };
    readForm.append(demo);
  }
  const status = node('p');
  status.setAttribute('role', 'status');
  const position = node('div');
  detail.append(node('p', 'Read a public wallet’s stake in the configured court. The configured RPC receives the address. This browser cannot sign or broadcast.'), readForm, status, position);
  let generation = 0;
  const matches = (turn, account) => !request.signal.aborted && turn === generation && wallet.value.trim() === account;
  wallet.oninput = () => {
    generation++;
    position.replaceChildren();
    status.textContent = '';
    wallet.setCustomValidity('');
  };
  readForm.onsubmit = async event => {
    event.preventDefault();
    const account = wallet.value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(account) || /^0x0{40}$/.test(account)) {
      wallet.setCustomValidity('Enter a nonzero public wallet address.');
      wallet.reportValidity();
      return;
    }
    const turn = ++generation;
    status.textContent = 'Reading stake position…';
    position.replaceChildren();
    try {
      const d = await api('stake?account=' + encodeURIComponent(account), request.signal);
      if (!matches(turn, account)) return;
      if (typeof d.account !== 'string' || d.account.toLowerCase() !== account.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(d.blockHash))
        throw new Error('The stake observation could not be identified.');
      status.textContent = 'Position read · ' + modes[ctx.mode] + (d.block ? ' · RPC block ' + d.block : '');
      position.append(fields([['Wallet', d.account], ['Court', d.courtId], ['Observation block hash', d.blockHash],
        ['Current court stake', formatStake(d.currentStakeRaw)], ['Total wallet stake', formatStake(d.totalStakeRaw)], ['Locked across courts', formatStake(d.totalLockedRaw)],
        ['Minimum court stake', formatStake(d.minimumStakeRaw)], ['Wallet balance', formatStake(d.balanceRaw)],
        ['Allowance to Kleros Core', formatStake(d.allowanceRaw)], ['Eligibility', d.eligible === true ? 'Eligible' : d.eligible === false ? 'Not eligible' : 'Unverified']]));
      if (formatStake(d.currentStakeRaw) === 'Unavailable') { position.append(node('p', 'Current stake must be verified before preview.')); return; }
      position.append(node('p', 'Increasing stake may need a separate token approval. A reduction is not a refund quote: locked amounts can remain. A zero target requests unstaking, not immediate withdrawal.'));
      if (d.canPreview !== true) { position.append(node('p', 'This profile supports reading only; stake simulation is unavailable.')); return; }
      stakePreview(position, d, account, turn, matches, request);
      const allowanceForm = localPreview(position, 'allowance-form', request, () => matches(turn, account), async form => {
        const mode = form.elements.mode.value;
        const body = { account, blockHash: d.blockHash, mode };
        if (mode === 'increase') body.target = form.elements.target.value;
        const approval = await api('preview/stake-allowance', request.signal, body);
        if (approval.submitted !== false || approval.mode !== mode || approval.account?.toLowerCase() !== account.toLowerCase() ||
            approval.blockHash !== d.blockHash || approval.courtId !== d.courtId || !/^0x[0-9a-fA-F]{40}$/.test(approval.spender) ||
            formatStake(approval.approvalRaw) === 'Unavailable' || (mode === 'clear' && approval.approvalRaw !== '0'))
          throw new Error('No matching unsigned allowance returned. Load the position again.');
        return [node('h4', 'Unsigned allowance simulation'), fields([['Spender (Kleros Core)', approval.spender],
          ['Current allowance', formatStake(d.allowanceRaw)], ['Simulated new allowance', formatStake(approval.approvalRaw)],
          ['Observation block hash', d.blockHash]]), node('p', 'No tokens were approved or transferred. No allowance or stake changed.')];
      });
      allowanceForm.elements.mode.onchange = () => {
        const target = allowanceForm.elements.target;
        target.disabled = target.parentElement.hidden = allowanceForm.elements.mode.value === 'clear';
      };
    } catch (err) {
      if (matches(turn, account)) status.textContent = 'Stake position unavailable. ' + err.message;
    }
  };
}

function stakePreview(container, observation, account, turn, matches, request) {
  const form = node('form');
  const label = node('label', 'Total target stake (HNY)');
  const target = node('input');
  target.required = true;
  target.inputMode = 'decimal';
  target.pattern = '[0-9]+(\\.[0-9]{1,18})?';
  target.maxLength = 79;
  target.autocomplete = 'off';
  label.append(target);
  const button = node('button', 'Simulate stake change', 'primary');
  const output = node('div');
  output.setAttribute('role', 'status');
  form.append(label, node('p', 'Enter the full desired court stake, not how much to add. This does not approve tokens, sign or broadcast.'), button);
  container.append(form, output);
  let pending = false, revision = 0;
  target.oninput = () => { revision++; target.setCustomValidity(''); output.replaceChildren(); };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!matches(turn, account) || pending) return;
    const amount = target.value.trim();
    if (!/^\d+(\.\d{1,18})?$/.test(amount) || amount.length > 79) {
      target.setCustomValidity('Enter a nonnegative HNY total with at most 18 decimal places.');
      target.reportValidity();
      return;
    }
    const inputRevision = revision;
    pending = true;
    button.disabled = true;
    output.textContent = 'Simulating unsigned stake change…';
    try {
      const d = await api('preview/stake', request.signal, { account, target: amount, blockHash: observation.blockHash });
      if (!matches(turn, account) || revision !== inputRevision) return;
      if (d.submitted !== false || !['immediate', 'delayed'].includes(d.delivery) ||
          typeof d.account !== 'string' || d.account.toLowerCase() !== account.toLowerCase() ||
          String(d.courtId) !== String(observation.courtId) || d.blockHash !== observation.blockHash)
        throw new Error('No matching unsigned observation was returned. Load the position again.');
      const delivery = d.delivery === 'delayed'
        ? 'Delayed if submitted. A queued change would not be applied yet and may fail later.'
        : 'Immediate path in simulation only. No stake changed.';
      output.replaceChildren(node('h4', 'Unsigned stake simulation'), node('p', delivery),
        fields([['Current court stake', formatStake(d.currentStakeRaw)], ['Total target stake', formatStake(d.targetStakeRaw)],
          ['Locked across courts', formatStake(d.totalLockedRaw)], ['Observation block hash', d.blockHash]]),
        node('p', 'This is not a withdrawal or refund quote. No signing or submission occurred.'));
    } catch (err) {
      if (matches(turn, account) && revision === inputRevision) output.textContent = 'Stake preview unavailable. ' + err.message;
    } finally {
      pending = false;
      if (matches(turn, account)) button.disabled = false;
    }
  };
}

function openPreview() {
  const request = showDialog('Preview a proposal');
  $('detail').append(node('p', modes[ctx.mode] + ' · Chain ' + ctx.chainId), $('proposal-form').content.cloneNode(true));
  const form = $('simulate');
  form.onsubmit = async event => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(form));
    input.stable = form.elements.stable.checked;
    const output = $('simulation');
    const submit = form.querySelector('button');
    submit.disabled = true;
    output.textContent = 'Simulating…';
    try {
      const d = await api('preview/proposal', request.signal, input);
      if (!request.signal.aborted) {
        output.replaceChildren(node('h3', 'Unsigned simulation'), node('p', modes[ctx.mode] +
          ' · Latest RPC state · Simulation block unavailable.'), fields([['Result', d.simulation], ['Method', d.method],
          ['Actor', d.from], ['Target', d.to], ['Estimated gas', d.gas], ...d.checks.map(c => [c.name, c.status])]));
      }
    } catch (err) { if (!request.signal.aborted) output.textContent = err.message; }
    finally { submit.disabled = false; }
  };
}

for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => {
  for (const other of document.querySelectorAll('[data-tab]')) other.removeAttribute('aria-current');
  button.setAttribute('aria-current', 'page');
  if (dialog.open) dialog.close();
  selected = undefined;
  area = button.dataset.tab; page = 1;
  $('filter').value = ''; $('lookup-id').value = ''; $('indexed-state').value = '';
  loadList();
};
$('inbox-account').oninput = () => {
  $('inbox-account').setCustomValidity('');
  inboxAccount = ''; page = 1; loadList();
};
$('inbox-form').onsubmit = event => {
  event.preventDefault();
  const input = $('inbox-account');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.value) || /^0x0{40}$/.test(input.value)) {
    input.setCustomValidity('Enter a nonzero public wallet address.'); input.reportValidity(); return;
  }
  inboxAccount = input.value; page = 1; loadList();
};
$('inbox-demo').onclick = () => {
  $('inbox-account').value = '0x3333333333333333333333333333333333333333';
  $('inbox-account').setCustomValidity('');
  $('inbox-form').requestSubmit();
};
$('lookup').onsubmit = event => { event.preventDefault(); if (ctx) openDetail(area, $('lookup-id').value); };
$('preview').onclick = () => { if (ctx) openPreview(); };
$('stake').onclick = () => { if (ctx) openStake(); };
$('close').onclick = () => $('dialog').close();
dialog.onclose = () => {
  if (dialog.open) return;
  detailRequest?.abort();
  $('detail').replaceChildren();
  if (dialog.classList.contains('inline')) inlineTrigger?.focus();
  highlightRecord();
};
wide.addEventListener('change', () => { if (dialog.open && dialog.classList.contains('inline')) dialog.close(); });
$('next').onclick = () => { page++; loadList(); };
$('previous').onclick = () => { if (page > 1) page--; loadList(); };
$('filter').oninput = render;
$('case-state').onchange = render;
$('indexed-state').onchange = () => { page = 1; loadList(); };
async function start() {
  try {
    ctx = await api('context');
    $('context').textContent = ctx.mode === 'fixture' ? 'Demo data · No live transactions' : chainNames[ctx.chainId] + ' · Local workspace';
    $('environment-mode').textContent = ctx.localSimulation || ctx.mode === 'fixture' ? 'Simulation only' : 'No live transactions';
    $('scope').replaceChildren(fields([['List source', sources[ctx.source]], ['Indexed DAO', ctx.dao],
      ['Kleros adapter', ctx.adapter ?? 'Unconfigured']]));
    await loadList();
  } catch { $('context').textContent = 'Local profile unavailable.'; notice('Could not read local context. Refresh to retry.', true); }
}
$('refresh').onclick = () => ctx ? loadList() : start();
start();
