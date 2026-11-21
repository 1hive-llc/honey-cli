import { addressPattern } from './schemas.js';

export const chainIdSchema = { enum: [100, 10200, 31337] } as const;
export const addressSchema = { type: 'string', pattern: addressPattern } as const;
export const fromSchema = addressSchema;
export const uintIdSchema = { oneOf: [{ type: 'string' }, { type: 'number' }] } as const;
export const amountStringSchema = { type: 'string', pattern: '^\\d+(\\.\\d+)?$' } as const;
export const hexBytesSchema = { type: 'string', pattern: '^0x[a-fA-F0-9]*$' } as const;
export const bytes32Schema = { type: 'string', pattern: '^0x[a-fA-F0-9]{64}$' } as const;

export function commonTxFields() {
  return { from: fromSchema, chainId: chainIdSchema } as const;
}
