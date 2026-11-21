import { decodeEventLog, type Hex } from 'viem';
import { agreementAbi } from '../abis/agreement.js';
import { convictionVotingAbi } from '../abis/convictionVoting.js';
import { disputableVotingAbi } from '../abis/disputableVoting.js';
import { ONEHIVE } from '../addresses.js';
import type { HexAddress, HexData } from '../schemas.js';

export type ReceiptLog = {
  address: HexAddress;
  topics: readonly HexData[];
  data: HexData;
};

export type ProposalAddedReadback = {
  eventName: 'ProposalAdded';
  proposalId: string;
  actionId: string;
  entity: HexAddress;
  title: string;
  link: HexData;
  amount: string;
  stable: boolean;
  beneficiary: HexAddress;
};

export type StakeEventReadback = {
  eventName: 'StakeAdded' | 'StakeWithdrawn';
  proposalId: string;
  entity?: HexAddress;
  amount: string;
  tokensStaked: string;
  totalTokensStaked: string;
  conviction: string;
};

export type AgreementEventReadback = {
  eventName: string;
  actionId?: string;
  challengeId?: string;
  signer?: HexAddress;
  settingId?: string;
};

export type DecisionEventReadback = {
  eventName: string;
  voteId?: string;
  actionId?: string;
  creator?: HexAddress;
  voter?: HexAddress;
  caster?: HexAddress;
  supports?: boolean;
  context?: HexData;
  executionScript?: HexData;
};

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function findProposalAddedLog(logs: readonly ReceiptLog[], convictionVotingAddress: HexAddress = ONEHIVE.CONVICTION_VOTING): ProposalAddedReadback {
  for (const log of logs) {
    if (!sameAddress(log.address, convictionVotingAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: convictionVotingAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName !== 'ProposalAdded') continue;
      const args = decoded.args as unknown as {
        entity: HexAddress;
        id: bigint;
        actionId: bigint;
        title: string;
        link: HexData;
        amount: bigint;
        stable: boolean;
        beneficiary: HexAddress;
      };
      return {
        eventName: 'ProposalAdded',
        proposalId: args.id.toString(),
        actionId: args.actionId.toString(),
        entity: args.entity,
        title: args.title,
        link: args.link,
        amount: args.amount.toString(),
        stable: args.stable,
        beneficiary: args.beneficiary
      };
    } catch {
      // Continue scanning unrelated or undecodable logs.
    }
  }
  throw new Error('event_not_found: ProposalAdded');
}

export function findStakeEventLog(logs: readonly ReceiptLog[], eventName: 'StakeAdded' | 'StakeWithdrawn', convictionVotingAddress: HexAddress = ONEHIVE.CONVICTION_VOTING): StakeEventReadback {
  for (const log of logs) {
    if (!sameAddress(log.address, convictionVotingAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: convictionVotingAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName !== eventName) continue;
      const args = decoded.args as unknown as {
        entity?: HexAddress;
        id: bigint;
        amount: bigint;
        tokensStaked: bigint;
        totalTokensStaked: bigint;
        conviction: bigint;
      };
      return {
        eventName,
        proposalId: args.id.toString(),
        ...(args.entity ? { entity: args.entity } : {}),
        amount: args.amount.toString(),
        tokensStaked: args.tokensStaked.toString(),
        totalTokensStaked: args.totalTokensStaked.toString(),
        conviction: args.conviction.toString()
      };
    } catch {
      // Continue scanning unrelated or undecodable logs.
    }
  }
  throw new Error(`event_not_found: ${eventName}`);
}

export function decodeDecisionEvents(logs: readonly ReceiptLog[], votingAddress: HexAddress = ONEHIVE.DISPUTABLE_VOTING): DecisionEventReadback[] {
  const events: DecisionEventReadback[] = [];
  for (const log of logs) {
    if (!sameAddress(log.address, votingAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: disputableVotingAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      const args = decoded.args as Record<string, unknown>;
      events.push({
        eventName: decoded.eventName,
        ...(typeof args.voteId === 'bigint' ? { voteId: args.voteId.toString() } : {}),
        ...(typeof args.actionId === 'bigint' ? { actionId: args.actionId.toString() } : {}),
        ...(typeof args.creator === 'string' ? { creator: args.creator as HexAddress } : {}),
        ...(typeof args.voter === 'string' ? { voter: args.voter as HexAddress } : {}),
        ...(typeof args.caster === 'string' ? { caster: args.caster as HexAddress } : {}),
        ...(typeof args.supports === 'boolean' ? { supports: args.supports } : {}),
        ...(typeof args.context === 'string' ? { context: args.context as HexData } : {}),
        ...(typeof args.executionScript === 'string' ? { executionScript: args.executionScript as HexData } : {})
      });
    } catch {
      // Continue scanning unrelated or undecodable logs.
    }
  }
  return events;
}

export function decodeAgreementEvents(logs: readonly ReceiptLog[], agreementAddress: HexAddress = ONEHIVE.AGREEMENT): AgreementEventReadback[] {
  const events: AgreementEventReadback[] = [];
  for (const log of logs) {
    if (!sameAddress(log.address, agreementAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: agreementAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      const args = decoded.args as Record<string, unknown>;
      events.push({
        eventName: decoded.eventName,
        ...(typeof args.actionId === 'bigint' ? { actionId: args.actionId.toString() } : {}),
        ...(typeof args.challengeId === 'bigint' ? { challengeId: args.challengeId.toString() } : {}),
        ...(typeof args.settingId === 'bigint' ? { settingId: args.settingId.toString() } : {}),
        ...(typeof args.signer === 'string' ? { signer: args.signer as HexAddress } : {})
      });
    } catch {
      // Continue scanning unrelated or undecodable logs.
    }
  }
  return events;
}
