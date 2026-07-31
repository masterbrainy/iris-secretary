import { describe, expect, it } from 'vitest';
import { describeCapability, isUsable, type CapabilityStatus } from './capability.js';

describe('capability status', () => {
  it('only treats live capabilities as usable', () => {
    expect(isUsable('live')).toBe(true);
    expect(isUsable('pending')).toBe(false);
    expect(isUsable('unsupported')).toBe(false);
  });

  it('describes every status without falling through to the exhaustiveness guard', () => {
    const all: CapabilityStatus[] = ['live', 'pending', 'unsupported'];
    for (const status of all) {
      expect(describeCapability(status)).not.toBe('');
    }
  });

  it('says plainly that a pending capability is stood in for by a simulator', () => {
    expect(describeCapability('pending')).toContain('simulator');
  });
});
