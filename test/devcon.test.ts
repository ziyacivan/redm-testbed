import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeCommand, FrameReader, hashString } from '../src/cfx/devcon.ts';

function printFrame(channelHash: number, message: string): Buffer {
  const text = Buffer.from(`${message}\0`, 'utf8');
  const frame = Buffer.alloc(40 + text.length);
  frame.write('PRNT', 0, 'ascii');
  frame.writeUInt16BE(211, 4);
  frame.writeUInt32BE(frame.length, 6);
  frame.writeUInt32LE(channelHash, 12);
  text.copy(frame, 40);
  return frame;
}

describe('devcon', () => {
  it('hashes like HashString', () => {
    expect(hashString('rcon')).toBe(2313349815);
    expect(hashString('RCON')).toBe(2313349815);
  });

  it('encodes CMND with a newline tail', () => {
    const frame = encodeCommand('connect 127.0.0.1:30120');
    expect(frame.toString('ascii', 0, 4)).toBe('CMND');
    expect(frame.readUInt16BE(4)).toBe(211);
    expect(frame.readUInt32BE(6)).toBe(frame.length);
    expect(frame.toString('utf8', 12)).toBe('connect 127.0.0.1:30120\n');
  });

  it('splits frames across chunks and decodes PRNT', () => {
    const reader = new FrameReader();
    const bytes = Buffer.concat([printFrame(5, 'one'), printFrame(6, 'two')]);
    expect(reader.push(bytes.subarray(0, 50))).toHaveLength(1);
    const [second] = reader.push(bytes.subarray(50));
    expect(second && decodeFrame(second)).toEqual({ type: 'print', channel: 6, message: 'two' });
  });
});
