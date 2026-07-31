export {
  describeCapability,
  isUsable,
  type CapabilityRegistry,
  type CapabilityStatus,
} from './capability.js';

export {
  A1MOBILE_CAPABILITIES,
  type A1MobileAdapter,
  type A1MobileCapability,
  type A1MobilePayload,
  type Authorization,
  type CallEndReason,
  type CommandContext,
  type CommandFailure,
  type CommandResult,
  type DeliveryContext,
  type GatherInput,
  type RawWebhookDelivery,
  type SendSmsInput,
  type SmsDeliveryStatus,
  type SpeakInput,
  type TransferInput,
  type VerificationFailure,
  type VerificationResult,
  type VerifiedInboundEvent,
} from './a1mobile/contract.js';

export { createA1MobileProductionAdapter } from './a1mobile/production.js';
export {
  createA1MobileSimulator,
  type A1MobileSimulator,
  type RecordedCommand,
  type SimulatorOptions,
} from './a1mobile/simulator.js';

export {
  META_WEARABLE_CAPABILITIES,
  type AdapterHealth,
  type DeliveryOptions,
  type DeliveryOutcome,
  type FounderAction,
  type FounderChannel,
  type FounderResponseEvent,
  type MetaWearableAdapter,
  type MetaWearableCapability,
  type UndeliverableReason,
  type Unsubscribe,
  type WearablePrompt,
} from './meta-wearable/contract.js';

export { createMetaWearableProductionAdapter } from './meta-wearable/production.js';
export {
  createMetaWearableSimulator,
  type DeliveredPrompt,
  type MetaWearableSimulator,
  type MetaWearableSimulatorOptions,
  type ResponseRejection,
  type ResponseResult,
} from './meta-wearable/simulator.js';
