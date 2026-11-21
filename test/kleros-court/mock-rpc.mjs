// Child-process test transport. All responses come from the synthetic fixture on disk.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recording = JSON.parse(readFileSync(process.env.COURT_TEST_RECORDING, 'utf8'));
const blockTag = '0x' + BigInt(recording.blockNumber).toString(16);
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'http://fixture.invalid/');
  const { id, method, params } = JSON.parse(init.body);
  let result;
  if (method === 'eth_chainId') result = '0x' + recording.chainId.toString(16);
  else if (method === 'eth_blockNumber') result = blockTag;
  else if (method === 'eth_getBlockByNumber') {
    assert.deepEqual(params, [blockTag, false]);
    result = { number: blockTag, hash: recording.blockHash, timestamp: '0x' + BigInt(recording.timestamp).toString(16) };
  } else {
    assert.equal(method, 'eth_call');
    const [{ to, data }, tag] = params;
    assert.deepEqual(params[0], { to, data });
    const expected = process.env.COURT_TEST_TAG;
    assert.deepEqual(tag, expected === 'hash' ? { blockHash: recording.blockHash, requireCanonical: true }
      : expected === 'number' ? blockTag : 'latest');
    const call = recording.calls.find(c => c.to.toLowerCase() === to.toLowerCase() && c.data === data);
    assert.ok(call, 'Missing fixture calldata');
    result = call.result;
  }
  return Response.json({ jsonrpc: '2.0', id, result });
};
