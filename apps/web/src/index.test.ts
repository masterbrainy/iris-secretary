import { describe, expect, it } from 'vitest';
import { capabilityBadgeText } from './index.js';

describe('capabilityBadgeText', () => {
  it('never renders a pending capability as if it were live', () => {
    expect(capabilityBadgeText('pending')).toContain('Pending');
    expect(capabilityBadgeText('pending')).not.toContain('Live');
  });
});
