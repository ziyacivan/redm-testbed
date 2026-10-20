// FiveM Legacy client remote console (devcon) over TCP on 127.0.0.1 (SPEC-0001 F4).
// Frame layout from citizenfx/fivem code/components/devcon/src/DevConServer.cpp:
// magic (4 ASCII) | protocol u16 BE (211) | total length u32 BE | body.
import net from 'node:net';

const PROTOCOL = 211;
const HEADER = 10;

// HashString of citizenfx/fivem code/client/shared/Utils.h: lowercase one-at-a-time hash.
export function hashString(text: string): number {
  let hash = 0;
  for (const byte of Buffer.from(text, 'utf8')) {
    const c = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    hash = (hash + (c >= 0x80 ? c - 0x100 : c)) >>> 0;
    hash = (hash + (hash << 10)) >>> 0;
    hash = (hash ^ (hash >>> 6)) >>> 0;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash = (hash ^ (hash >>> 11)) >>> 0;
  return (hash + (hash << 15)) >>> 0;
}

export function encodeCommand(command: string): Buffer {
  if (/[\r\n]/.test(command)) throw new Error('a console command must be one line');
  const text = Buffer.from(`${command}\n`, 'utf8');
  const frame = Buffer.alloc(HEADER + 2 + text.length);
  frame.write('CMND', 0, 'ascii');
  frame.writeUInt16BE(PROTOCOL, 4);
  frame.writeUInt32BE(frame.length, 6);
  text.copy(frame, HEADER + 2);
  return frame;
}

export type DevconFrame =
  | { type: 'print'; channel: number; message: string }
  | { type: 'channels'; channels: { hash: number; name: string }[] }
  | { type: 'other'; magic: string };

function cString(buffer: Buffer, start: number, end: number): string {
  const zero = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, zero >= 0 && zero < end ? zero : end);
}

export function decodeFrame(frame: Buffer): DevconFrame {
  const magic = frame.toString('ascii', 0, 4);
  if (magic === 'PRNT') {
    return { type: 'print', channel: frame.readUInt32LE(12), message: cString(frame, 40, frame.length) };
  }
  if (magic === 'CHAN') {
    const count = frame.readUInt32BE(HEADER);
    const channels = [];
    for (let i = 0; i < count; i++) {
      const at = HEADER + 4 + i * 58;
      if (at + 58 > frame.length) break;
      channels.push({ hash: frame.readUInt32LE(at), name: cString(frame, at + 24, at + 54) });
    }
    return { type: 'channels', channels };
  }
  return { type: 'other', magic };
}

// Splits a TCP stream into frames by the length field.
export class FrameReader {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length >= HEADER) {
      const length = this.pending.readUInt32BE(6);
      if (length < HEADER) {
        this.pending = Buffer.alloc(0);
        break;
      }
      if (this.pending.length < length) break;
      frames.push(this.pending.subarray(0, length));
      this.pending = this.pending.subarray(length);
    }
    return frames;
  }
}

export interface DevconLine {
  channel: string;
  message: string;
}

export class DevconConnection {
  private socket: net.Socket | undefined;
  private readonly channels = new Map<number, string>();
  private readonly onLine: (line: DevconLine) => void;

  constructor(onLine: (line: DevconLine) => void) {
    this.onLine = onLine;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  connect(port = 29200): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const reader = new FrameReader();
      const timer = setTimeout(() => socket.destroy(new Error('devcon connect timeout')), 3000);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.setKeepAlive(true, 10_000);
        socket.write(Buffer.from('PPCR', 'ascii'));
        resolve();
      });
      socket.on('data', (chunk: Buffer) => {
        for (const frame of reader.push(chunk)) this.receive(decodeFrame(frame));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
      });
    });
  }

  private receive(frame: DevconFrame): void {
    if (frame.type === 'channels') {
      for (const channel of frame.channels) this.channels.set(channel.hash, channel.name);
    } else if (frame.type === 'print') {
      const channel = this.channels.get(frame.channel) ?? `#${frame.channel.toString(16)}`;
      for (const message of frame.message.split(/\r?\n/)) {
        if (message.length > 0) this.onLine({ channel, message });
      }
    }
  }

  send(command: string): void {
    if (!this.socket || this.socket.destroyed) throw new Error('devcon is not connected (is RedM running?)');
    this.socket.write(encodeCommand(command));
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
