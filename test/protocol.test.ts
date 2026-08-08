import { describe, expect, it } from 'vitest';
import { encodeFrame, LineDecoder, type Frame, type Request } from '../src/shared/protocol.js';

describe('protocol framing', () => {
  it('round-trips requests and frames over chunked input', () => {
    const req: Request = { id: 1, command: 'do', args: { instruction: 'hi "there"\nline2' } };
    const result: Frame = { id: 1, type: 'result', ok: true, data: { x: 1 } };
    const wire = encodeFrame(req) + encodeFrame(result);

    const decoder = new LineDecoder<Request | Frame>();
    const out: (Request | Frame)[] = [];
    // feed byte-by-byte to exercise partial-line buffering
    for (const ch of wire) out.push(...decoder.push(ch));

    expect(out).toEqual([req, result]);
  });

  it('ignores blank lines and preserves order', () => {
    const decoder = new LineDecoder<{ n: number }>();
    const frames = decoder.push('{"n":1}\n\n{"n":2}\n{"n":');
    expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decoder.push('3}\n')).toEqual([{ n: 3 }]);
  });
});
