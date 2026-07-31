import { describe, expect, it } from 'vitest';
import { assertNever } from '@cynthia/domain';
import { describeCapability } from '@cynthia/adapters';

/**
 * Placeholder e2e suite. The real scenario gates (direct answer, clarification,
 * live relay, founder timeout, knowledge reuse, sensitive escalation, duplicate
 * webhook, provider outage) land in roadmap phase 7 once the orchestrator and
 * simulators exist. For now this proves the e2e project is wired into the root
 * test run and can import every workspace package.
 */
describe('e2e harness', () => {
  it('can reach the domain and adapter packages', () => {
    expect(describeCapability('live')).toContain('Live');
    expect(() => assertNever('unreachable' as never)).toThrow();
  });
});
