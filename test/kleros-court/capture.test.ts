import { custom, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { captureCourtRecording } from '../../src/kleros-court/capture.js';
import { coreAbi } from '../../src/kleros-court/abis.js';
import { caseFixture, caseRequest, core } from './fixture.js';

const input = { command: 'resolve', ...caseRequest };
const header = { number: '0x1c2', hash: '0x' + '12'.repeat(32), timestamp: '0x96' };
function mock({ chain = '0x7a69', block = header, result }: { chain?: string; block?: typeof header | null; result?: Hex } = {}) {
  const methods: string[] = [];
  const transport = custom({ request: async ({ method, params }) => {
    methods.push(method);
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') {
      expect(params).toEqual(['0x1c2', false]);
      return block;
    }
    expect(method).toBe('eth_call');
    expect(params[1]).toEqual({ blockHash: header.hash, requireCanonical: true });
    if (result) return result;
    throw new Error('Mock provider cannot serve canonical hash (fixture-marker).');
  } }, { retryCount: 0 });
  return { methods, transport };
}

describe('read-only capture', () => {
  it('validates the request and an explicit uint256 height before constructing a transport', async () => {
    const rpc = mock();
    for (const invalid of ['', 'latest', '-1', '0x1c2', (2n ** 256n).toString()]) {
      expect((await captureCourtRecording(input, invalid, rpc.transport)).error?.code).toBe('court_input');
    }
    expect((await captureCourtRecording({ ...input, command: 'submit' }, '450', rpc.transport)).error?.code).toBe('court_input');
    expect(rpc.methods).toEqual([]);
  });

  it('stops before loading a block on the wrong chain', async () => {
    const rpc = mock({ chain: '0x64' });
    expect((await captureCourtRecording(input, '450', rpc.transport)).error?.code).toBe('wrong_chain');
    expect(rpc.methods).toEqual(['eth_chainId']);
  });

  it.each([null, { ...header, number: '0x1c3' }, { ...header, hash: '' }])(
    'requires a mined header that matches the requested height', async block => {
      const rpc = mock({ block });
      expect((await captureCourtRecording(input, '450', rpc.transport)).error?.code).toBe('block_unavailable');
      expect(rpc.methods).toEqual(['eth_chainId', 'eth_getBlockByNumber']);
    }
  );

  it('fails closed on unavailable canonical state without retrying a latest or number-only call', async () => {
    const rpc = mock();
    const capture = await captureCourtRecording(input, '450', rpc.transport);
    expect(capture.error?.code).toBe('court_capture_failed');
    expect(capture.data).toBeUndefined();
    expect(JSON.stringify(capture)).not.toContain('fixture-marker');
    expect(rpc.methods).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_call']);
  });

  it('rejects malformed getter return bytes before emitting any recording', async () => {
    const rpc = mock({ result: '0xab' });
    const capture = await captureCourtRecording(input, '450', rpc.transport);
    expect(capture.error?.message).toMatch(/Invalid return data for pinakion/);
    expect(capture.data).toBeUndefined();
  });

  it('requires the same winning choice in Core and the final adapter record', () => {
    const source = caseFixture({ id: 0n, period: 4, finalised: true, ruling: 4n })
      .set(core, coreAbi, 'currentRuling', [0n], [1n, false, false]);
    expect(source.run('resolve', caseRequest).error?.message).toMatch(/Core ruling differs/);
    expect(source.run('settlement', caseRequest).error?.message).toMatch(/Core ruling differs/);
  });
});
