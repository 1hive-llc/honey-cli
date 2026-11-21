import { detectLikelySecret } from '../onehive/policy.js';

export function publicEvidenceReference(value: string): boolean {
  if (!value || value !== value.trim() || value.length > 500 || Buffer.byteLength(value, 'utf8') > 1024 ||
      /[\p{C}\p{Zl}\p{Zp}]/u.test(value) || detectLikelySecret(value).length) return false;
  if (/^ipfs:\/\/(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,119})$/.test(value)) return true;
  // Text labels only. No gateways, URLs, paths, queries, embedded credentials or links.
  return /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,_()'-]*$/u.test(value) &&
    !/[\p{L}\p{N}][.]\p{L}{2,}/u.test(value) && !/\b0x[0-9a-f]{64}\b/i.test(value);
}
