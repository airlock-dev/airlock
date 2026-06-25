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
  it('returns a UUID string', () => {
    expect(generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
