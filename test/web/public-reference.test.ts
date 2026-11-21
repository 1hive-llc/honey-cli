import { expect, it } from 'vitest';
import { publicEvidenceReference } from '../../src/web/public-reference.js';

it('accepts public labels and bare CID-shaped references without opening them', () => {
  expect(publicEvidenceReference('Exhibit A (orchard map), v2.')).toBe(true);
  expect(publicEvidenceReference('ipfs://Qm' + '1'.repeat(44))).toBe(true);
  expect(publicEvidenceReference('ipfs://b' + 'a'.repeat(58))).toBe(true);
});

it('rejects URL paths, remote data, hidden chars, secrets, and excessive UTF-8 bounds', () => {
  for (const input of ['www.example.org', 'https://example.org/a', 'Exhibit A\nMore', 'Exhibit\u200bA',
    ' Exhibit A', 'Exhibit A ', '0x' + 'a'.repeat(64), 'ghp_' + 'X'.repeat(30),
    'ipfs://Qm' + '1'.repeat(44) + '?token=secret', 'ipfs://Qm' + '1'.repeat(44) + '/file',
    '証'.repeat(342), 'a'.repeat(501), 'name@example.org']) expect(publicEvidenceReference(input)).toBe(false);
});
