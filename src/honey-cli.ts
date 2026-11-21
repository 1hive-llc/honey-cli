import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from 'node:process';
import {
  ONEHIVE,
  buildKeystorePolicyPreset,
  createEncryptedKeystore,
  defaultKeystorePolicyPath,
  fail,
  getOneHiveTool,
  listKeystores,
  loadKeystorePolicy,
  ok,
  oneHiveTools,
  readPassphraseFromFile,
  type KeystorePolicyPreset,
  type OneHiveToolResult
} from './onehive/index.js';

import { courtHelp, isCourtRoute } from './kleros-court/routes.js';

export type CliIO = {
  stdin?: string;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
};

type ParsedFlags = { positional: string[]; flags: Record<string, string | boolean | string[]> };

type Dispatch = { toolName: string; input: Record<string, unknown> };

class CliUsageError extends Error {}

const CHAIN_FLAG_DEFAULT = 100;

function parseArgs(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s).filter((part) => part !== undefined);
    if (!rawName) continue;
    const name = rawName.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i] : true;
    if (flags[name] !== undefined) {
      const existing = flags[name];
      flags[name] = Array.isArray(existing) ? [...existing, String(value)] : [String(existing), String(value)];
    } else {
      flags[name] = value ?? true;
    }
  }
  return { positional, flags };
}

function flagString(flags: ParsedFlags['flags'], name: string): string | undefined {
  const value = flags[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(flags: ParsedFlags['flags'], name: string): number | undefined {
  const value = flagString(flags, name);
  return value === undefined ? undefined : Number(value);
}

function flagBool(flags: ParsedFlags['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

function flagList(flags: ParsedFlags['flags'], name: string): string[] | undefined {
  const value = flags[name];
  if (Array.isArray(value)) return value.flatMap((entry) => entry.split(',').map((item) => item.trim()).filter(Boolean));
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

function rejectKeeperPasswordFlag(flags: ParsedFlags['flags']): void {
  if (flags.password !== undefined) {
    throw new Error('The --password keeper-secret path has been removed because CLI arguments leak through shell history and process lists. Use an explicit 32-byte --salt value instead.');
  }
}

function rejectKeystoreSecretFlags(flags: ParsedFlags['flags']): void {
  if (flags.passphrase !== undefined || flags.privateKey !== undefined || flags.keystorePassphrase !== undefined) {
    throw new Error('Keystore passphrases/private keys must not be supplied in CLI arguments. Use stdin for private-key import and HONEY_KEYSTORE_PASSPHRASE_FILE or --passphrase-file for the passphrase.');
  }
}

function withCommon(input: Record<string, unknown>, flags: ParsedFlags['flags']): Record<string, unknown> {
  const chain = flagNumber(flags, 'chain') ?? flagNumber(flags, 'chainId');
  const from = flagString(flags, 'from');
  return {
    ...input,
    ...(chain ? { chainId: chain } : {}),
    ...(from ? { from } : {})
  };
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function jsonInputFromCli(jsonArg: string | undefined, io: CliIO): Record<string, unknown> {
  const raw = jsonArg ?? io.stdin;
  if (!raw || !raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool input JSON must be an object.');
  return parsed as Record<string, unknown>;
}

function jsonInputFromFileOrStdin(path: string | undefined, io: CliIO): unknown {
  const raw = path ? readFileSync(path, 'utf8') : io.stdin;
  if (!raw || !raw.trim()) throw new Error('JSON input file or stdin is required.');
  return JSON.parse(raw) as unknown;
}

function extractTxPreview(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transaction preview JSON must be an object.');
  const record = value as Record<string, unknown>;
  if (record.ok === true && record.data && typeof record.data === 'object' && !Array.isArray(record.data)) return record.data as Record<string, unknown>;
  if (record.tx && typeof record.tx === 'object' && !Array.isArray(record.tx)) return record.tx as Record<string, unknown>;
  return record;
}

function signerModeFromFlags(flags: ParsedFlags['flags']): string | undefined {
  if (Object.keys(flags).some(key => /^(walletconnect|resendAmbiguous)/i.test(key))) throw new Error('Mobile wallet pairing is not supported in this release.');
  if (flagBool(flags, 'safe')) return 'safe';
  if (flagBool(flags, 'ledger')) return 'ledger';
  if (flagBool(flags, 'devPrivateKey')) return 'dev-private-key';
  if (flagBool(flags, 'keystore')) return 'keystore';
  if (flagBool(flags, 'externalSigner')) return 'external-signer';
  if (flagBool(flags, 'signerDaemon')) return 'signer-daemon';
  return flagString(flags, 'signerMode');
}

type AreaDispatchContext = { action: string | undefined; subject: string | undefined; flags: ParsedFlags['flags']; io: CliIO };
type AreaDispatcher = (context: AreaDispatchContext) => Dispatch | undefined;

const SIGNER_PID_FILE = '.pi/sessions/honey-signer.pid';

function signerPidPath(flags: ParsedFlags['flags']): string {
  return flagString(flags, 'pidFile') ?? process.env.HONEY_SIGNER_PID_FILE ?? SIGNER_PID_FILE;
}

function pidIsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function runSignerManager(action: string | undefined, flags: ParsedFlags['flags']): Promise<OneHiveToolResult<unknown>> {
  const pidFile = signerPidPath(flags);
  if (action === 'status' || action === undefined) {
    if (!existsSync(pidFile)) return ok({ running: false, pidFile });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return ok({ running: Number.isInteger(pid) && pidIsRunning(pid), pid, pidFile, socket: flagString(flags, 'socket') ?? process.env.HONEY_SIGNER_SOCKET });
  }
  if (action === 'stop') {
    if (!existsSync(pidFile)) return ok({ stopped: false, reason: 'pid_file_missing', pidFile });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pidIsRunning(pid)) process.kill(pid, 'SIGTERM');
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return ok({ stopped: true, pid, pidFile });
  }
  if (action === 'start') {
    const existingPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined;
    if (existingPid && pidIsRunning(existingPid)) return ok({ running: true, pid: existingPid, pidFile }, ['honey-signer is already running.']);
    const keystore = flagString(flags, 'keystore') ?? flagString(flags, 'keystoreAccount') ?? flagString(flags, 'account');
    if (!keystore) throw new Error('signer start requires --keystore LABEL_OR_ADDRESS.');
    const socket = flagString(flags, 'socket') ?? process.env.HONEY_SIGNER_SOCKET ?? '.pi/honey-signer.sock';
    mkdirSync(dirname(pidFile), { recursive: true });
    mkdirSync(dirname(socket), { recursive: true });
    const args = [resolve('bin/honey-signer.mjs'), 'start', '--keystore', keystore, '--socket', socket];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, HONEY_SIGNER_SOCKET: socket } });
    child.unref();
    writeFileSync(pidFile, `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
    return ok({ started: true, pid: child.pid, pidFile, socket }, ['Started honey-signer in the background. It can only unlock non-interactively when HONEY_KEYSTORE_ALLOW_PASSPHRASE_FILE=1 or another non-agent secret channel is configured.']);
  }
  return fail('unknown_signer_command', `Unknown honey signer command: ${action ?? ''}`, undefined, false);
}


const areaDispatchers: Record<string, AreaDispatcher> = {
  tool: ({ action, subject, io }) => ({ toolName: requireArg(action, 'tool name'), input: jsonInputFromCli(subject, io) }),
  submit: ({ action, flags, io }) => {
    rejectKeystoreSecretFlags(flags);
    const inputJson = jsonInputFromFileOrStdin(action, io);
    const tx = extractTxPreview(inputJson);
    return {
      toolName: 'onehive_tx_submit',
      input: {
        tx,
        confirmationPhrase: flagString(flags, 'confirmationPhrase') ?? flagString(flags, 'confirm') ?? flagString(flags, 'phrase'),
        signerMode: signerModeFromFlags(flags) ?? 'safe',
        safeAddress: flagString(flags, 'safeAddress'),
        keystoreAccount: flagString(flags, 'keystoreAccount') ?? flagString(flags, 'keystore') ?? flagString(flags, 'keystoreLabel'),
        externalSignerUrl: flagString(flags, 'externalSignerUrl') ?? flagString(flags, 'signerUrl'),
        externalSignerSocket: flagString(flags, 'externalSignerSocket') ?? flagString(flags, 'signerSocket')
      }
    };
  },
};

export function buildDispatch(args: string[], io: CliIO = {}): Dispatch {
  const { positional, flags } = parseArgs(args);
  const [area, action, subject] = positional;

  if (!area || area === 'help' || flagBool(flags, 'help')) throw new Error(helpText());

  const areaDispatch = areaDispatchers[area]?.({ action, subject, flags, io });
  if (areaDispatch) return areaDispatch;

  if (area === 'token') {
    if (action === 'balance' || action === 'balances') {
      return { toolName: 'onehive_context_resolve', input: { chainId: flagNumber(flags, 'chain') ?? flagNumber(flags, 'chainId') ?? CHAIN_FLAG_DEFAULT, includeBalancesFor: subject ?? flagString(flags, 'address'), verifyCode: flagBool(flags, 'verifyCode') } };
    }
    if (action === 'info' || action === 'status') {
      return { toolName: 'onehive_context_resolve', input: { chainId: flagNumber(flags, 'chain') ?? flagNumber(flags, 'chainId') ?? CHAIN_FLAG_DEFAULT, verifyCode: flagBool(flags, 'verifyCode') } };
    }
    if (action === 'quote') {
      const side = flagBool(flags, 'buy') ? 'buy' : flagBool(flags, 'sell') ? 'sell' : flagString(flags, 'side');
      const inputAmount = flagString(flags, 'input');
      const outputAmount = flagString(flags, 'output');
      return { toolName: 'onehive_honey_quote', input: withCommon({ side, exact: inputAmount ? 'input' : 'output', amount: inputAmount ?? outputAmount, slippageBps: flagNumber(flags, 'slippageBps') }, flags) };
    }
    if (action === 'approve') {
      return { toolName: 'onehive_honey_approveTx', input: withCommon({ token: flagString(flags, 'token'), amount: flagString(flags, 'amount'), spender: flagString(flags, 'spender'), unlimited: flagBool(flags, 'unlimited'), unlimitedApprovalConfirmation: flagString(flags, 'unlimitedApprovalConfirmation') }, flags) };
    }
    if (action === 'swap' || action === 'buy' || action === 'sell') {
      const side = action === 'buy' || action === 'sell' ? action : flagString(flags, 'side');
      const inputAmount = flagString(flags, 'input');
      const outputAmount = flagString(flags, 'output');
      return { toolName: 'onehive_honey_swapTx', input: withCommon({ side, exact: inputAmount ? 'input' : 'output', amount: inputAmount ?? outputAmount, slippageBps: flagNumber(flags, 'slippageBps'), recipient: flagString(flags, 'recipient'), quoteId: flagString(flags, 'quoteId'), deadlineMinutes: flagNumber(flags, 'deadlineMinutes') }, flags) };
    }
  }

  if (area === 'kleros' && action === 'stake') {
    return { toolName: 'onehive_kleros_stakeTx', input: { chainId: flagNumber(flags, 'chain') ?? flagNumber(flags, 'chainId'),
      core: flagString(flags, 'core'), expectedToken: flagString(flags, 'expectedToken'), from: flagString(flags, 'from'),
      courtId: flagString(flags, 'court'), amount: flagString(flags, 'amount') } };
  }

  if (area === 'kleros' && action === 'adapter-status') {
    return { toolName: 'onehive_kleros_adapterStatus', input: { chainId: flagNumber(flags, 'chain') ?? flagNumber(flags, 'chainId'),
      core: flagString(flags, 'core'), expectedToken: flagString(flags, 'expectedToken'), adapter: flagString(flags, 'adapter'),
      agreement: flagString(flags, 'agreement'), disputeId: flagString(flags, 'dispute') } };
  }

  if (area === 'kleros' && action === 'status') {
    return { toolName: 'onehive_kleros_status', input: { chainId: flagNumber(flags, 'chain') ?? flagNumber(flags, 'chainId'), core: flagString(flags, 'core'), expectedToken: flagString(flags, 'expectedToken') } };
  }

  if (area === 'proposals') {
    if (action === 'list') {
      const network = flagNumber(flags, 'chain') ?? flagNumber(flags, 'network') ?? CHAIN_FLAG_DEFAULT;
      return {
        toolName: 'onehive_honey_proposals_list',
        input: {
          dao: flagString(flags, 'dao') ?? ONEHIVE.DAO_KERNEL,
          chainId: network,
          first: flagNumber(flags, 'limit') ?? flagNumber(flags, 'first'),
          skip: flagNumber(flags, 'skip'),
          statuses: flagList(flags, 'status') ?? flagList(flags, 'statuses'),
          types: flagList(flags, 'type') ?? flagList(flags, 'types'),
          orderBy: flagString(flags, 'orderBy'),
          orderDirection: flagString(flags, 'orderDirection'),
          crossCheckRpc: flagBool(flags, 'noRpc') ? false : flagString(flags, 'crossCheckRpc') === 'false' ? false : undefined
        }
      };
    }
    if (action === 'show') return { toolName: 'onehive_governance_getProposal', input: withCommon({ proposalId: subject }, flags) };
    if (action === 'forecast') return { toolName: 'onehive_honey_proposal_forecast', input: withCommon({ proposalId: subject, averageBlockTimeSeconds: flagNumber(flags, 'averageBlockTimeSeconds') ?? flagNumber(flags, 'blockTime') }, flags) };
    if (action === 'stake') return { toolName: 'onehive_governance_stakeTx', input: withCommon({ proposalId: subject, amountHny: flagString(flags, 'amount'), all: flagBool(flags, 'all') }, flags) };
    if (action === 'withdraw') return { toolName: 'onehive_governance_withdrawTx', input: withCommon({ proposalId: subject, amountHny: flagString(flags, 'amount'), all: flagBool(flags, 'all') }, flags) };
    if (action === 'execute') return { toolName: 'onehive_governance_executeTx', input: withCommon({ proposalId: subject }, flags) };
    if (action === 'create') return { toolName: 'onehive_governance_addProposalTx', input: withCommon({ title: flagString(flags, 'title'), link: flagString(flags, 'link'), requestedAmountHnyOrWxDai: flagString(flags, 'amount'), stableRequestAmount: flagBool(flags, 'stable'), beneficiary: flagString(flags, 'beneficiary') }, flags) };
  }

  if (area === 'decisions') {
    if (action === 'show') return { toolName: 'onehive_decision_getVote', input: withCommon({ voteId: subject, voter: flagString(flags, 'voter') }, flags) };
    if (action === 'create') return { toolName: 'onehive_decision_newVoteTx', input: withCommon({ context: flagString(flags, 'context'), executionScript: flagString(flags, 'executionScript') }, flags) };
    if (action === 'vote') return { toolName: 'onehive_decision_voteTx', input: withCommon({ voteId: subject, supports: flagBool(flags, 'yes') ? true : flagBool(flags, 'no') ? false : undefined }, flags) };
    if (action === 'execute') return { toolName: 'onehive_decision_executeTx', input: withCommon({ voteId: subject, executionScript: flagString(flags, 'executionScript') }, flags) };
  }

  if (area === 'disputes') {
    if (action === 'status') {
      const options = ['proposal', 'vote', 'adapter', 'agreement', 'chain', 'chainId', 'json', 'preview'];
      if (subject !== undefined || Object.keys(flags).some(name => !options.includes(name)) ||
        (flags.chain !== undefined && flags.chainId !== undefined)) {
        throw new CliUsageError('Use disputes status [--proposal ID | --vote ID] [--chain ID] [--agreement ADDRESS] [--adapter ADDRESS].');
      }
      return { toolName: 'onehive_agreement_courtStatus', input: {
        chainId: Number(flags.chain ?? flags.chainId ?? CHAIN_FLAG_DEFAULT), agreement: flags.agreement,
        proposalId: flags.proposal, voteId: flags.vote, adapter: flags.adapter
      } };
    }
    if (action === 'sign') return { toolName: 'onehive_celeste_signAgreementTx', input: withCommon({ settingId: flagString(flags, 'setting') ?? subject }, flags) };
    if (action === 'show') return { toolName: 'onehive_celeste_getAgreementState', input: withCommon({ actionId: flagString(flags, 'action') ?? subject, signer: flagString(flags, 'signer'), disputableApp: flagString(flags, 'disputableApp') }, flags) };
    if (action === 'challenge') return { toolName: 'onehive_celeste_challengeActionTx', input: withCommon({ actionId: flagString(flags, 'action') ?? subject, settlementOfferHny: flagString(flags, 'settlementOffer') ?? '0', finishedEvidence: flagBool(flags, 'finishedEvidence'), context: flagString(flags, 'evidence') ?? flagString(flags, 'context') }, flags) };
    if (action === 'settle') return { toolName: 'onehive_celeste_settleActionTx', input: withCommon({ actionId: flagString(flags, 'action') ?? subject }, flags) };
    if (action === 'dispute') return { toolName: 'onehive_celeste_disputeActionTx', input: withCommon({ actionId: flagString(flags, 'action') ?? subject, submitterFinishedEvidence: flagBool(flags, 'submitterFinishedEvidence') }, flags) };
    if (action === 'evidence') return { toolName: 'onehive_celeste_submitEvidenceTx', input: withCommon({ disputeId: flagString(flags, 'dispute') ?? subject, evidence: flagString(flags, 'evidence'), finished: flagBool(flags, 'finished') }, flags) };
    if (action === 'close') return { toolName: 'onehive_celeste_closeActionTx', input: withCommon({ actionId: flagString(flags, 'action') ?? subject }, flags) };
  }

  if (area === 'court') {
    if (action === 'status') return { toolName: 'onehive_court_status', input: withCommon({ verifyCode: flagBool(flags, 'verifyCode') }, flags) };
    if (action === 'heartbeat') return { toolName: 'onehive_court_heartbeatTx', input: withCommon({ maxTransitions: flagNumber(flags, 'maxTransitions') }, flags) };
    if (action === 'subgraph' && subject === 'status') return { toolName: 'onehive_court_subgraphStatus', input: withCommon({ celesteSubgraphUrl: flagString(flags, 'celesteSubgraphUrl'), agreementSubgraphUrl: flagString(flags, 'agreementSubgraphUrl'), maxIndexedAgeSeconds: flagNumber(flags, 'maxIndexedAgeSeconds') }, flags) };
    if (action === 'stake') return { toolName: 'onehive_court_stakeTx', input: withCommon({ amountHny: flagString(flags, 'amount'), juror: flagString(flags, 'juror'), data: flagString(flags, 'data') }, flags) };
    if (action === 'activate') return { toolName: 'onehive_court_activateTx', input: withCommon({ amountHny: flagString(flags, 'amount') }, flags) };
    if (action === 'deactivate') return { toolName: 'onehive_court_deactivateTx', input: withCommon({ amountHny: flagString(flags, 'amount') }, flags) };
    if (action === 'unstake') return { toolName: 'onehive_court_unstakeTx', input: withCommon({ amountHny: flagString(flags, 'amount') }, flags) };
    if (action === 'commit') {
      rejectKeeperPasswordFlag(flags);
      return { toolName: 'onehive_court_commitTx', input: withCommon({ voteId: flagString(flags, 'voteId'), disputeId: flagString(flags, 'dispute') ?? subject, roundId: flagString(flags, 'round'), commitment: flagString(flags, 'commitment'), outcome: flagString(flags, 'outcome'), salt: flagString(flags, 'salt') }, flags) };
    }
    if (action === 'reveal') {
      rejectKeeperPasswordFlag(flags);
      return { toolName: 'onehive_court_revealTx', input: withCommon({ voteId: flagString(flags, 'voteId'), disputeId: flagString(flags, 'dispute') ?? subject, roundId: flagString(flags, 'round'), juror: flagString(flags, 'juror'), outcome: flagString(flags, 'outcome'), salt: flagString(flags, 'salt') }, flags) };
    }
    if (action === 'appeal') return { toolName: 'onehive_court_appealTx', input: withCommon({ disputeId: flagString(flags, 'dispute') ?? subject, roundId: flagString(flags, 'round'), outcome: flagString(flags, 'outcome'), ruling: flagString(flags, 'ruling'), confirm: flagBool(flags, 'confirm'), mode: flagString(flags, 'mode') }, flags) };
    if (action === 'rewards') return { toolName: 'onehive_court_rewards', input: withCommon({ disputeId: flagString(flags, 'dispute') ?? subject, roundId: flagString(flags, 'round'), juror: flagString(flags, 'juror') }, flags) };
    if (action === 'claim-rewards' || (action === 'claim' && subject === 'rewards')) return { toolName: 'onehive_court_claimRewardsTx', input: withCommon({ disputeId: flagString(flags, 'dispute') ?? (action === 'claim-rewards' ? subject : undefined), roundId: flagString(flags, 'round'), juror: flagString(flags, 'juror') }, flags) };
  }

  throw new Error(`Unknown honey command: ${positional.join(' ')}`);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested), 2);
}

async function runKeystoreCli(action: string | undefined, subject: string | undefined, flags: ParsedFlags['flags'], io: CliIO): Promise<OneHiveToolResult<unknown>> {
  rejectKeystoreSecretFlags(flags);
  const dir = flagString(flags, 'dir');
  if (action === 'list' || action === 'ls' || action === undefined) return ok(await listKeystores(dir));
  if (action === 'show-policy' || action === 'policy') {
    const path = flagString(flags, 'policy') ?? defaultKeystorePolicyPath();
    return ok({ path, policy: await loadKeystorePolicy(path) });
  }
  if (action === 'default-policy' || action === 'init-policy') {
    const account = flagString(flags, 'account') ?? flagString(flags, 'address') ?? subject;
    if (!account || !/^0x[a-fA-F0-9]{40}$/.test(account)) throw new Error('A valid --account 0x... address is required to create the default safe automation policy.');
    const label = flagString(flags, 'label');
    const preset = flagString(flags, 'preset') ?? 'safe-automation';
    if (!['safe-automation', 'full-governance', 'full-access'].includes(preset)) throw new Error('--preset must be safe-automation, full-governance, or full-access.');
    const policy = buildKeystorePolicyPreset({ address: account as `0x${string}`, ...(label ? { label } : {}), preset: preset as KeystorePolicyPreset });
    const path = flagString(flags, 'policy') ?? defaultKeystorePolicyPath();
    if (flagBool(flags, 'write')) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return ok({ path, policy }, [`Wrote ${preset} keystore policy. safe-automation allows only support/unsupport and heartbeat; full-governance excludes swaps/transfers; full-access relies on submit-time allowlist/ABI policy and includes swaps/transfers.`]);
    }
    return ok({ path, policy }, [`Preview only. Add --write to write this ${preset} keystore policy.`]);
  }
  if (action === 'generate' || action === 'import') {
    const passphrasePath = flagString(flags, 'passphraseFile');
    const original = process.env.HONEY_KEYSTORE_PASSPHRASE_FILE;
    if (passphrasePath) process.env.HONEY_KEYSTORE_PASSPHRASE_FILE = passphrasePath;
    try {
      const passphrase = await readPassphraseFromFile();
      const privateKey = action === 'import' ? (io.stdin ?? '').trim() : undefined;
      if (action === 'import' && !privateKey) throw new Error('Private key import requires the private key on stdin, not as a CLI argument.');
      const metadata = await createEncryptedKeystore({ label: flagString(flags, 'label') ?? subject ?? 'onehive-keystore', passphrase, ...(privateKey ? { privateKey: privateKey as `0x${string}` } : {}), ...(flagString(flags, 'expectedAddress') ? { expectedAddress: flagString(flags, 'expectedAddress') as `0x${string}` } : {}), ...(dir ? { dir } : {}) });
      return ok(metadata, ['Encrypted keystore created. Back it up securely and authorize it explicitly in the keystore policy before signing.']);
    } finally {
      if (passphrasePath) {
        if (original === undefined) delete process.env.HONEY_KEYSTORE_PASSPHRASE_FILE;
        else process.env.HONEY_KEYSTORE_PASSPHRASE_FILE = original;
      }
    }
  }
  return fail('unknown_keystore_command', `Unknown honey keystore command: ${action ?? ''}`, undefined, false);
}

function humanSummary(toolName: string, result: OneHiveToolResult<unknown>): string {
  const lines: string[] = [];
  lines.push(`${result.ok ? 'OK' : 'ERROR'} ${toolName}`);
  if (result.warnings?.length) for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (!result.ok) lines.push(`${result.error?.code ?? 'error'}: ${result.error?.message ?? 'Unknown error.'}`);
  if (result.ok && result.data && typeof result.data === 'object') {
    const data = result.data as Record<string, unknown>;
    const summary = (data.decoded as { humanSummary?: string } | undefined)?.humanSummary;
    if (summary) lines.push(summary);
    else lines.push(stableStringify(result.data));
  } else if (result.ok && result.data !== undefined) {
    lines.push(String(result.data));
  }
  return `${lines.join('\n')}\n`;
}

export async function runHoneyCli(args: string[], io: CliIO = {}): Promise<number> {
  if (isCourtRoute(args)) {
    const { runCourtCli } = await import('./kleros-court/cli.js');
    return runCourtCli(args, io);
  }
  const stdout = io.stdout ?? processStdout;
  const stderr = io.stderr ?? processStderr;
  const { positional, flags } = parseArgs(args);
  try {
    if (positional[0] === 'keystore') {
      const result = await runKeystoreCli(positional[1], positional[2], flags, io);
      const json = flagBool(flags, 'json') || flagBool(flags, 'preview');
      stdout.write(json ? `${stableStringify(result)}\n` : humanSummary('honey_keystore', result));
      return result.ok ? 0 : 1;
    }
    if (positional[0] === 'signer') {
      const result = await runSignerManager(positional[1], flags);
      const json = flagBool(flags, 'json') || flagBool(flags, 'preview');
      stdout.write(json ? `${stableStringify(result)}\n` : humanSummary('honey_signer', result));
      return result.ok ? 0 : 1;
    }
    const dispatch = buildDispatch(args, io);
    const tool = getOneHiveTool(dispatch.toolName);
    if (!tool) throw new Error(`Unknown tool ${dispatch.toolName}. Available tools: ${oneHiveTools.map((entry) => entry.name).join(', ')}`);
      const result = await tool.handler(dispatch.input) as OneHiveToolResult<unknown>;
    const json = flagBool(flags, 'json') || flagBool(flags, 'preview');
    stdout.write(json ? `${stableStringify(result)}\n` : humanSummary(dispatch.toolName, result));
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CliUsageError && (flagBool(flags, 'json') || flagBool(flags, 'preview'))) {
      stdout.write(`${stableStringify(fail('invalid_arguments', error.message))}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : 'Unknown CLI error.';
    stderr.write(`${message}\n`);
    return message.startsWith('Usage:') ? 0 : 1;
  }
}

export function helpText(): string {
  return `Usage: honey <area> <command> [args] [--json]

Areas:
  tool <onehive_tool_name> [json]           Dispatch a raw active onehive_* tool.
  submit [preview.json] --confirm PHRASE    Confirmation-gated Safe/keystore/signer handoff.
  keystore list|generate|import|show-policy|default-policy Encrypted local keystore metadata and setup.
  signer start|stop|status                 Manage local honey-signer listener.
  token quote|approve|buy|sell|swap         Honey token quotes and previews.
  proposals list|show|forecast|create|stake|withdraw|execute
  decisions show|create|vote|execute
  disputes sign|show|challenge|settle|dispute|evidence|close
  disputes status [--proposal ID | --vote ID] [--chain ID] [--agreement ADDRESS] [--adapter ADDRESS]
    Read the current Agreement setting. Supply a Conviction proposal or Decision vote for its saved setting and latest challenge.
    --adapter identifies the Honey/Kleros Agreement adapter for court details. Gnosis Celeste is labeled legacy.
    Adapter rulings are 2 (void), 3 (challenger) or 4 (submitter). Agreement resolution can follow later.
  kleros stake --chain ID --core ADDRESS --expected-token ADDRESS --from ADDRESS --court ID --amount HNY (unsigned preview; submission blocked)
  kleros status --chain ID --core ADDRESS --expected-token ADDRESS (read-only)
  kleros adapter-status --chain ID --core ADDRESS --expected-token ADDRESS --adapter ADDRESS --agreement ADDRESS [--dispute ID]
${courtHelp}
  court status|heartbeat|subgraph status|stake|activate|deactivate|unstake|commit|reveal|appeal|rewards|claim-rewards

Examples:
  honey token quote --side buy --exact input --amount 1 --json
  honey proposals list --limit 5 --json
  honey proposals forecast 213 --json
  honey court status --json
  honey court heartbeat --max-transitions 20 --from 0x... --json
  honey court commit <disputeId> --round 0 --outcome 1 --salt 0x<32-byte-hex> --from 0x...
  honey submit preview.json --confirm "<exact confirmation phrase>" # unsigned Safe handoff
  honey keystore list --json
  honey keystore default-policy --preset safe-automation --account 0x... --label bot --write --json
  honey keystore default-policy --preset full-governance --account 0x... --json
  honey keystore default-policy --preset full-access --account 0x... --json
  honey submit preview.json --keystore --keystore-account LABEL --confirm "<exact confirmation phrase>"
  honey signer start --keystore bot --socket .pi/honey-signer.sock
  honey submit preview.json --signer-daemon --confirm "<exact confirmation phrase>"

Safety notes:
  - Transaction commands build unsigned previews; signing/submission goes through confirmation-gated submit.
  - Celeste challenge/dispute/appeal/keeper actions can risk collateral or keeper penalties.
  - Keeper commit/reveal secrets must use explicit --salt; --password is rejected because CLI args leak.
  - Keystore passphrases/private keys are never accepted as CLI args; use interactive unlock for signing and stdin for imports.
  - Unlimited approvals require the exact generated confirmation phrase.
`;
}

export async function main(): Promise<void> {
  let stdinText: string | undefined;
  if (!processStdin.isTTY) {
    try { stdinText = readFileSync(0, 'utf8'); } catch { stdinText = undefined; }
  }
  const io: CliIO = stdinText === undefined ? {} : { stdin: stdinText };
  const code = await runHoneyCli(process.argv.slice(2), io);
  process.exit(code);
}
