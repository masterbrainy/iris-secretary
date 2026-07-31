import { assertNever } from '@cynthia/domain';

/**
 * Every provider capability carries one of these, and the founder console
 * surfaces it. `pending` is the honest default for anything whose provider
 * integration is contract-only — see docs/architecture.md. The UI must never
 * let a founder believe a pending capability is live.
 */
export type CapabilityStatus = 'live' | 'pending' | 'unsupported';

export type CapabilityRegistry<Name extends string = string> = Readonly<
  Record<Name, CapabilityStatus>
>;

/** Copy for the integration-status panel. */
export function describeCapability(status: CapabilityStatus): string {
  switch (status) {
    case 'live':
      return 'Live — backed by a working provider integration.';
    case 'pending':
      return 'Pending — the contract exists, but the provider integration is not available yet. A simulator stands in.';
    case 'unsupported':
      return 'Unsupported — the provider cannot do this. A fallback is used instead.';
    default:
      return assertNever(status, 'CapabilityStatus');
  }
}

/**
 * Only `live` capabilities may be relied on for a real side effect. Callers
 * gate on this rather than on truthiness, so adding a fourth status forces a
 * decision here instead of silently defaulting to "usable".
 */
export function isUsable(status: CapabilityStatus): boolean {
  return status === 'live';
}
