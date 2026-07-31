import { describeCapability, isUsable, type CapabilityRegistry } from '@iris/adapters';

/**
 * Provider capability status for this deployment.
 *
 * Both entries are `pending` deliberately, and that is the honest state today:
 * a1mobile publishes no developer API, and the Meta toolkit exposes no audio
 * API and needs hardware plus an approved developer account we do not have.
 * See docs/architecture.md §2 and §3. Simulators stand in for both, and the
 * founder console renders this map so nobody mistakes a simulator for a live
 * integration.
 */
export const capabilities = {
  'a1mobile.inboundCall': 'pending',
  'a1mobile.sendSms': 'pending',
  'metaWearable.deliverPrompt': 'pending',
} as const satisfies CapabilityRegistry;

export function integrationStatusReport(): string[] {
  return Object.entries(capabilities).map(
    ([name, status]) => `${name}: ${describeCapability(status)}`,
  );
}

/** Nothing may perform a real side effect until its capability is live. */
export function canPerform(capability: keyof typeof capabilities): boolean {
  return isUsable(capabilities[capability]);
}
