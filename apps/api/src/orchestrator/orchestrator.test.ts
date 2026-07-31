import { beforeEach, describe, expect, it } from 'vitest';
import { createA1MobileSimulator, type A1MobileSimulator } from '@iris/adapters';
import { createInMemoryPorts, type InMemoryPorts } from './in-memory.js';
import { conversationEventFor, createOrchestrator, type Orchestrator } from './orchestrator.js';

let phone: A1MobileSimulator;
let ports: InMemoryPorts;
let orchestrator: Orchestrator;
let traceCounter = 0;

function ctx() {
  traceCounter += 1;
  return { traceId: `trace-${String(traceCounter)}`, receivedAt: ports.clock.now() };
}

beforeEach(() => {
  traceCounter = 0;
  phone = createA1MobileSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
  ports = createInMemoryPorts('2026-07-31T10:00:00.000Z');
  orchestrator = createOrchestrator({ telephony: phone, ports });
});

/** Ring, then answer — the shared preamble for most cases. */
async function ringAndAnswer() {
  const incoming = await orchestrator.handleInboundEvent(
    phone.incomingCall({ from: '+15550001', to: '+15559999' }),
    ctx(),
  );
  const callId = phone.knownCalls()[0]!;
  const answered = await orchestrator.handleInboundEvent(phone.callAnswered(callId), ctx());
  return { incoming, answered, callId };
}

describe('intake', () => {
  it('creates a conversation in RINGING for an inbound call', async () => {
    await orchestrator.handleInboundEvent(
      phone.incomingCall({ from: '+15550001', to: '+15559999' }),
      ctx(),
    );

    const conversations = ports.conversations.all();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.state).toBe('RINGING');
    expect(conversations[0]?.callerNumber).toBe('+15550001');
  });

  it('moves to ACTIVE when the call is answered', async () => {
    const { answered } = await ringAndAnswer();

    expect(answered.kind).toBe('processed');
    if (answered.kind === 'processed') expect(answered.state).toBe('ACTIVE');
  });

  it('routes later events to the conversation the call belongs to', async () => {
    const { callId } = await ringAndAnswer();
    await orchestrator.handleInboundEvent(phone.callEnded(callId, 'caller-hung-up'), ctx());

    expect(ports.conversations.all()).toHaveLength(1);
    expect(ports.conversations.all()[0]?.state).toBe('ENDED');
  });

  it('refuses a webhook that fails verification, without creating anything', async () => {
    const raw = phone.incomingCall({ from: '+1', to: '+2' });
    const tampered = { ...raw, body: raw.body.replace('+1', '+9') };

    const result = await orchestrator.handleInboundEvent(tampered, ctx());

    expect(result.kind).toBe('rejected');
    expect(ports.conversations.all()).toHaveLength(0);
    expect(ports.audit.ofKind('ingest-rejected')).toHaveLength(1);
  });
});

describe('every transition is an audit event', () => {
  it('records one audit event per accepted transition, and no more', async () => {
    const { callId } = await ringAndAnswer();
    await orchestrator.handleInboundEvent(phone.callEnded(callId, 'caller-hung-up'), ctx());

    const transitions = ports.audit.ofKind('transition');
    expect(transitions.map((t) => t.event.to)).toEqual(['ACTIVE', 'ENDED']);
    expect(transitions.map((t) => t.event.event)).toEqual(['CALL_ANSWERED', 'CALLER_HUNG_UP']);
  });

  it('carries the trace id and conversation id on every transition', async () => {
    await ringAndAnswer();
    const audit = ports.audit.ofKind('transition')[0]!;

    expect(audit.event.conversationId).toBe(ports.conversations.all()[0]?.conversationId);
    expect(audit.event.traceId).toBe('trace-2');
  });

  it('audits an event that carries information but moves no state', async () => {
    const { callId } = await ringAndAnswer();
    await orchestrator.handleInboundEvent(
      phone.callerSaid({ callId, text: 'what are your hours?' }),
      ctx(),
    );

    const observed = ports.audit.ofKind('observed');
    expect(observed).toHaveLength(2); // call.incoming + the transcript segment
    expect(observed.at(-1)?.providerEventKind).toBe('transcript.segment');
  });

  it('audits a rejected transition and leaves the state alone', async () => {
    const { callId } = await ringAndAnswer();

    // Answering an already-answered call is not legal.
    const again = await orchestrator.handleInboundEvent(phone.callAnswered(callId), ctx());

    expect(again.kind).toBe('transition-rejected');
    expect(ports.conversations.all()[0]?.state).toBe('ACTIVE');

    const rejected = ports.audit.ofKind('transition-rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.attemptedEvent).toBe('CALL_ANSWERED');
    expect(rejected[0]?.rejection.reason).toBe('not-allowed');
  });

  it('audits a rejection rather than silently doing nothing', async () => {
    const { callId } = await ringAndAnswer();
    await orchestrator.handleInboundEvent(phone.callEnded(callId, 'caller-hung-up'), ctx());
    await orchestrator.handleInboundEvent(phone.callEnded(callId, 'completed'), ctx());

    // An ended conversation refuses everything; the timeline has to show that
    // something arrived and was turned away, not just fall silent.
    const rejected = ports.audit.ofKind('transition-rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.rejection.reason).toBe('terminal-state');
  });
});

describe('duplicate delivery', () => {
  it('skips a redelivered webhook without a second transition', async () => {
    const { callId } = await ringAndAnswer();
    const answeredAgain = phone.callAnswered(callId);

    // Deliver the same event twice.
    await orchestrator.handleInboundEvent(answeredAgain, ctx());
    const transitionsBefore = ports.audit.ofKind('transition').length;
    const duplicate = await orchestrator.handleInboundEvent(phone.redeliver(answeredAgain), ctx());

    expect(duplicate.kind).toBe('skipped-duplicate');
    expect(ports.audit.ofKind('transition')).toHaveLength(transitionsBefore);
  });

  it('does not create a second conversation for a redelivered inbound call', async () => {
    const raw = phone.incomingCall({ from: '+15550001', to: '+15559999' });
    await orchestrator.handleInboundEvent(raw, ctx());
    await orchestrator.handleInboundEvent(phone.redeliver(raw), ctx());

    expect(ports.conversations.all()).toHaveLength(1);
  });

  it('records the skip with a pointer back to the delivery that did the work', async () => {
    const raw = phone.incomingCall({ from: '+1', to: '+2' });
    await orchestrator.handleInboundEvent(raw, ctx());
    await orchestrator.handleInboundEvent(phone.redeliver(raw), ctx());

    const skipped = ports.audit.ofKind('duplicate-skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.originalTraceId).toBe('trace-1');
    expect(skipped[0]?.traceId).toBe('trace-2');
  });

  it('still processes a genuinely different event after a duplicate', async () => {
    const raw = phone.incomingCall({ from: '+1', to: '+2' });
    await orchestrator.handleInboundEvent(raw, ctx());
    await orchestrator.handleInboundEvent(phone.redeliver(raw), ctx());

    const callId = phone.knownCalls()[0]!;
    const answered = await orchestrator.handleInboundEvent(phone.callAnswered(callId), ctx());

    expect(answered.kind).toBe('processed');
  });
});

describe('out-of-order delivery', () => {
  it('flags a late event but still processes it', async () => {
    const incoming = phone.incomingCall({ from: '+1', to: '+2' });
    const callId = phone.knownCalls()[0]!;
    const answered = phone.callAnswered(callId);

    // The provider delivers the call itself first, so the conversation exists,
    // then a much later event, then the earlier one arrives behind it.
    await orchestrator.handleInboundEvent(incoming, ctx());
    await orchestrator.handleInboundEvent(phone.callEnded(callId, 'caller-hung-up'), ctx());
    const late = await orchestrator.handleInboundEvent(answered, ctx());

    // ENDED refuses it — which is the right answer, and is audited.
    expect(late.kind).toBe('transition-rejected');
    expect(ports.audit.ofKind('transition-rejected')).toHaveLength(1);
  });

  it('never moves the high-water mark backwards', async () => {
    const incoming = phone.incomingCall({ from: '+1', to: '+2' });
    const callId = phone.knownCalls()[0]!;
    const answered = phone.callAnswered(callId);
    const said = phone.callerSaid({ callId, text: 'hello' });

    await orchestrator.handleInboundEvent(incoming, ctx());
    await orchestrator.handleInboundEvent(said, ctx());
    await orchestrator.handleInboundEvent(answered, ctx());

    const conversationId = ports.conversations.all()[0]!.conversationId;
    expect(await ports.ledger.highWaterMark(conversationId)).toBe(3);
  });
});

describe('event mapping', () => {
  it('maps only the payloads that genuinely move state', () => {
    expect(conversationEventFor({ kind: 'call.answered', callId: 'c' })).toBe('CALL_ANSWERED');
    expect(conversationEventFor({ kind: 'call.ended', callId: 'c', reason: 'completed' })).toBe(
      'CALLER_HUNG_UP',
    );
    expect(
      conversationEventFor({ kind: 'call.incoming', callId: 'c', from: '+1', to: '+2' }),
    ).toBeUndefined();
    expect(
      conversationEventFor({
        kind: 'transcript.segment',
        callId: 'c',
        text: 'x',
        confidence: 1,
        isFinal: true,
      }),
    ).toBeUndefined();
    expect(
      conversationEventFor({ kind: 'sms.status', messageId: 'm', status: 'delivered' }),
    ).toBeUndefined();
  });
});

describe('determinism', () => {
  it('produces an identical audit trail for an identical script', async () => {
    async function run() {
      const sim = createA1MobileSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
      const p = createInMemoryPorts('2026-07-31T10:00:00.000Z');
      const o = createOrchestrator({ telephony: sim, ports: p });

      let trace = 0;
      const next = () => {
        trace += 1;
        return { traceId: `t-${String(trace)}`, receivedAt: p.clock.now() };
      };

      await o.handleInboundEvent(sim.incomingCall({ from: '+1', to: '+2' }), next());
      const callId = sim.knownCalls()[0]!;
      await o.handleInboundEvent(sim.callAnswered(callId), next());
      await o.handleInboundEvent(sim.callEnded(callId, 'caller-hung-up'), next());
      return p.audit.records;
    }

    expect(await run()).toEqual(await run());
  });
});
