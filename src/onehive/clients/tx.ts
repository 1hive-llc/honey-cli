import { generateConfirmationPhrase } from '../policy.js';
import type { ChainId, HexAddress, HexData, PolicyCheck, TxPreview } from '../schemas.js';

export type BuildTxPreviewInput = {
  chainId: ChainId;
  from?: HexAddress;
  to: HexAddress;
  value?: string;
  data: HexData;
  contractName: string;
  method: string;
  args?: Record<string, unknown>;
  humanSummary: string;
  checks?: PolicyCheck[];
  risk?: TxPreview['policy']['risk'];
};

export function buildTxPreview(input: BuildTxPreviewInput): TxPreview {
  const previewBase: Omit<TxPreview, 'policy'> = {
    chainId: input.chainId,
    to: input.to,
    value: input.value ?? '0',
    data: input.data,
    decoded: {
      contractName: input.contractName,
      method: input.method,
      args: input.args ?? {},
      humanSummary: input.humanSummary
    },
    simulation: {
      status: 'not-run' as const
    }
  };
  if (input.from) previewBase.from = input.from;

  return {
    ...previewBase,
    policy: {
      risk: input.risk ?? 'medium',
      requiresConfirmation: true,
      confirmationPhrase: generateConfirmationPhrase(previewBase),
      checks: input.checks ?? []
    }
  };
}
