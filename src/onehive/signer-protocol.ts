import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HexAddress, TxPreview } from './schemas.js';

export const SIGNER_PROTOCOL_VERSION = 1 as const;
const SECRET_FIELD_RE = /(?:privateKey|private_key|passphrase|password|mnemonic|seed)/i;

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested), 2);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function previewHash(tx: Pick<TxPreview, 'chainId' | 'from' | 'to' | 'value' | 'data' | 'decoded'>): string {
  return sha256Hex(stableJson({ chainId: tx.chainId, from: tx.from, to: tx.to, value: tx.value, data: tx.data, decoded: tx.decoded }));
}

function containsSecretField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecretField);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => SECRET_FIELD_RE.test(key) || containsSecretField(nested));
}

const hexAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hexDataSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);
const txPreviewSchema = z.object({
  chainId: z.union([z.literal(100), z.literal(10200), z.literal(31337)]),
  from: hexAddressSchema.optional(),
  to: hexAddressSchema,
  value: z.string().regex(/^\d+$/),
  data: hexDataSchema,
  decoded: z.object({ contractName: z.string(), method: z.string(), args: z.record(z.string(), z.unknown()), humanSummary: z.string() }),
  simulation: z.object({ status: z.enum(['success', 'revert', 'not-run']), gasEstimate: z.string().optional(), revertReason: z.string().optional() }),
  policy: z.object({ risk: z.enum(['low', 'medium', 'high', 'critical']), requiresConfirmation: z.literal(true), confirmationPhrase: z.string(), checks: z.array(z.object({ name: z.string(), status: z.enum(['pass', 'fail', 'warn']), detail: z.string() })) })
});

export const signerRequestSchema = z.object({
  version: z.literal(SIGNER_PROTOCOL_VERSION),
  requestId: z.string().min(8),
  action: z.literal('submit'),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmationPhraseHash: z.string().regex(/^[a-f0-9]{64}$/),
  account: hexAddressSchema.optional(),
  label: z.string().optional(),
  tx: txPreviewSchema,
  preflight: z.object({ activeChainId: z.number(), selector: z.object({ selector: z.string().optional(), lockedMethod: z.string().optional(), abiLockStatus: z.enum(['match', 'missing', 'mismatch']), methodSelectorKnown: z.boolean(), decodedMethodMatches: z.boolean() }), checks: z.array(z.object({ name: z.string(), status: z.enum(['pass', 'fail', 'warn']), detail: z.string() })) })
}).strict().superRefine((value, ctx) => {
  if (containsSecretField(value)) ctx.addIssue({ code: 'custom', message: 'Signer request must not contain private-key, passphrase, mnemonic, seed, or password fields.' });
  if (previewHash(value.tx as TxPreview) !== value.previewHash) ctx.addIssue({ code: 'custom', message: 'Signer request previewHash does not match tx preview.' });
  if (value.account && value.tx.from && value.account.toLowerCase() !== value.tx.from.toLowerCase()) ctx.addIssue({ code: 'custom', message: 'Signer request account does not match tx.from.' });
});

export const signerResponseSchema = z.object({
  version: z.literal(SIGNER_PROTOCOL_VERSION),
  requestId: z.string().min(8),
  status: z.enum(['submitted', 'rejected', 'ambiguous', 'error']),
  txHash: hexDataSchema.optional(),
  signerAuditId: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional()
}).strict().superRefine((value, ctx) => {
  if (containsSecretField(value)) ctx.addIssue({ code: 'custom', message: 'Signer response must not contain private-key, passphrase, mnemonic, seed, or password fields.' });
  if (value.status === 'submitted' && !value.txHash) ctx.addIssue({ code: 'custom', message: 'Submitted signer responses must include txHash.' });
});

export type SignerRequest = z.infer<typeof signerRequestSchema>;
export type SignerResponse = z.infer<typeof signerResponseSchema>;

export function buildSignerRequest(input: { requestId: string; tx: TxPreview; confirmationPhrase: string; preflight: SignerRequest['preflight']; account?: HexAddress; label?: string }): SignerRequest {
  const redactedTx: TxPreview = { ...input.tx, policy: { ...input.tx.policy, confirmationPhrase: '[REDACTED]' } };
  return signerRequestSchema.parse({
    version: SIGNER_PROTOCOL_VERSION,
    requestId: input.requestId,
    action: 'submit',
    previewHash: previewHash(input.tx),
    confirmationPhraseHash: sha256Hex(input.confirmationPhrase),
    ...(input.account ? { account: input.account } : {}),
    ...(input.label ? { label: input.label } : {}),
    tx: redactedTx,
    preflight: input.preflight
  });
}
