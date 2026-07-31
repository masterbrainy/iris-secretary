import { describeCapability, type CapabilityStatus } from '@cynthia/adapters';

/**
 * Placeholder for the founder console (roadmap 6.1). It exists now so the
 * workspace, typecheck, lint and test harness genuinely cover this package
 * rather than skipping over an empty directory. The Vite/React stack is added
 * in 6.1, when there is a UI to build.
 */
export function capabilityBadgeText(status: CapabilityStatus): string {
  return describeCapability(status);
}
