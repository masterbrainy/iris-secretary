import { describe, expect, it } from 'vitest';
import { canPerform, capabilities, integrationStatusReport } from './index.js';

describe('integration status', () => {
  it('refuses every side effect while its provider integration is pending', () => {
    expect(canPerform('a1mobile.sendSms')).toBe(false);
    expect(canPerform('metaWearable.deliverPrompt')).toBe(false);
  });

  it('reports a line per capability', () => {
    expect(integrationStatusReport()).toHaveLength(Object.keys(capabilities).length);
  });

  it('resolves the workspace dependency chain api -> adapters -> domain', () => {
    expect(integrationStatusReport()[0]).toContain('simulator');
  });
});
