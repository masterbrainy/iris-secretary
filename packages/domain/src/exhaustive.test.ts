import { describe, expect, it } from 'vitest';
import { assertNever } from './exhaustive.js';

describe('assertNever', () => {
  it('names the offending value so an unhandled case is diagnosable from the message alone', () => {
    expect(() => assertNever('RINGING' as never)).toThrow('Unhandled case: "RINGING"');
  });

  it('includes the union being switched over when given a context', () => {
    expect(() => assertNever(7 as never, 'ConversationState')).toThrow(
      'Unhandled case in ConversationState: 7',
    );
  });
});
