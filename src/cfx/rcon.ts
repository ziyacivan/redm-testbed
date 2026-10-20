// FXServer RCON over UDP (SPEC-0001 F2). The request and the reply start with four 0xFF bytes.
import dgram from 'node:dgram';

const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function encodeRconRequest(password: string, command: string): Buffer {
  if (/[\r\n]/.test(command)) throw new Error('an RCON command must be one line');
  return Buffer.concat([PREFIX, Buffer.from(`rcon ${password} ${command}`, 'utf8')]);
}

export function decodeRconReply(data: Buffer): string {
  if (data.length < 4 || !data.subarray(0, 4).equals(PREFIX)) throw new Error('not an RCON reply');
  const text = data.subarray(4).toString('utf8');
  if (!text.startsWith('print')) throw new Error(`unexpected RCON reply: ${text.slice(0, 40)}`);
  return text.slice('print'.length).replace(/^ /, '');
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
  // FXServer can split a long reply into several datagrams. Collect until this quiet time ends.
  quietMs?: number;
}

export function rcon(options: RconOptions, command: string): Promise<string> {
  const { host, port, password, timeoutMs = 5000, quietMs = 150 } = options;
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const parts: string[] = [];
    let quiet: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      clearTimeout(quiet);
      socket.close();
      if (error) reject(error);
      else resolve(parts.join(''));
    };
    const timeout = setTimeout(() => finish(new Error(`no RCON reply from ${host}:${port}`)), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('message', (message, remote) => {
      if (remote.port !== port) return;
      try {
        parts.push(decodeRconReply(message));
      } catch (error) {
        finish(error as Error);
        return;
      }
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(), quietMs);
    });
    socket.send(encodeRconRequest(password, command), port, host);
  });
}
