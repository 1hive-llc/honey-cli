import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { convictionVotingAbi } from '../../src/onehive/abis/convictionVoting.js';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { ONEHIVE } from '../../src/onehive/addresses.js';
import { decodeAgreementEvents, findProposalAddedLog, findStakeEventLog, type ReceiptLog } from '../../src/onehive/clients/event-readback.js';
import type { HexAddress, HexData } from '../../src/onehive/schemas.js';

const entity = '0x1111111111111111111111111111111111111111' as HexAddress;
const beneficiary = '0x2222222222222222222222222222222222222222' as HexAddress;

function proposalAddedLog(): ReceiptLog {
  return {
    address: ONEHIVE.CONVICTION_VOTING,
    topics: encodeEventTopics({ abi: convictionVotingAbi, eventName: 'ProposalAdded', args: { entity, id: 123n, actionId: 456n } }) as HexData[],
    data: encodeAbiParameters(
      [
        { type: 'string', name: 'title' },
        { type: 'bytes', name: 'link' },
        { type: 'uint256', name: 'amount' },
        { type: 'bool', name: 'stable' },
        { type: 'address', name: 'beneficiary' }
      ],
      ['Fork proposal', '0xabcdef', 789n, false, beneficiary]
    )
  };
}

describe('fork event readback helpers', () => {
  it('extracts proposal ID from ProposalAdded receipt logs', () => {
    const result = findProposalAddedLog([proposalAddedLog()]);

    expect(result).toMatchObject({
      eventName: 'ProposalAdded',
      proposalId: '123',
      actionId: '456',
      entity,
      title: 'Fork proposal',
      link: '0xabcdef',
      amount: '789',
      stable: false,
      beneficiary
    });
  });

  it('extracts stake and withdraw events from receipt logs', () => {
    const stakeLog: ReceiptLog = {
      address: ONEHIVE.CONVICTION_VOTING,
      topics: encodeEventTopics({ abi: convictionVotingAbi, eventName: 'StakeAdded', args: { entity, id: 123n } }) as HexData[],
      data: encodeAbiParameters(
        [
          { type: 'uint256', name: 'amount' },
          { type: 'uint256', name: 'tokensStaked' },
          { type: 'uint256', name: 'totalTokensStaked' },
          { type: 'uint256', name: 'conviction' }
        ],
        [1n, 2n, 3n, 4n]
      )
    };

    expect(findStakeEventLog([stakeLog], 'StakeAdded')).toEqual({
      eventName: 'StakeAdded',
      proposalId: '123',
      entity,
      amount: '1',
      tokensStaked: '2',
      totalTokensStaked: '3',
      conviction: '4'
    });
  });

  it('throws a clear event_not_found error when proposal event is absent', () => {
    expect(() => findProposalAddedLog([])).toThrow('event_not_found: ProposalAdded');
  });

  it('decodes Agreement lifecycle events', () => {
    const logs: ReceiptLog[] = [
      {
        address: ONEHIVE.AGREEMENT,
        topics: encodeEventTopics({ abi: agreementAbi, eventName: 'ActionChallenged', args: { actionId: 1n, challengeId: 2n } }) as HexData[],
        data: '0x'
      },
      {
        address: ONEHIVE.AGREEMENT,
        topics: encodeEventTopics({ abi: agreementAbi, eventName: 'Signed', args: { signer: entity } }) as HexData[],
        data: encodeAbiParameters([{ type: 'uint256', name: 'settingId' }], [7n])
      }
    ];

    expect(decodeAgreementEvents(logs)).toEqual([
      { eventName: 'ActionChallenged', actionId: '1', challengeId: '2' },
      { eventName: 'Signed', signer: entity, settingId: '7' }
    ]);
  });
});
