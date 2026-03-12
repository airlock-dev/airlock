import { describe, it, expect } from 'vitest';
import { generateApprovalCode, generateId } from '../src/util/id.js';

describe('generateApprovalCode()', () => {
  it('returns an 8-character string', () => {
    expect(generateApprovalCode()).toHaveLength(8);
  });

  it('contains only uppercase letters and digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateApprovalCode()).toMatch(/^[A-Z0-9]{8}$/);
    }
  });

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateApprovalCode()));
    // With 36^8 ≈ 2.8T possibilities, 100 codes should all be unique
    expect(codes.size).toBe(100);
  });
});

describe('generateId()', () => {
  it('returns a hex string', () => {
    expect(generateId()).toMatch(/^[0-9a-f]+$/);
  });

  it('returns 32 hex chars (16 bytes)', () => {
    expect(generateId()).toHaveLength(32);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
