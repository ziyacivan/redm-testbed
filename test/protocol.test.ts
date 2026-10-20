import { describe, expect, it } from 'vitest';
import { decodeRconReply, encodeRconRequest } from '../src/cfx/rcon.ts';
import { pipeName, projectConfig } from '../src/protocol/config.ts';
import { isMethodName } from '../src/protocol/messages.ts';
import { LineSplitter } from '../src/protocol/rpc.ts';

describe('rcon framing', () => {
  it('encodes a request with the 0xFF prefix', () => {
    const packet = encodeRconRequest('secret', 'status');
    expect([...packet.subarray(0, 4)]).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(packet.subarray(4).toString()).toBe('rcon secret status');
  });

  it('refuses a multi-line command', () => {
    expect(() => encodeRconRequest('secret', 'a\nquit')).toThrow();
  });

  it('decodes a print reply', () => {
    const reply = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('print hello\n')]);
    expect(decodeRconReply(reply)).toBe('hello\n');
  });
});

describe('LineSplitter', () => {
  it('joins partial lines across chunks', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\r\n')).toEqual(['{"b":2}']);
  });
});

describe('project config', () => {
  it('applies the defaults', () => {
    const config = projectConfig.parse({
      host: 'neo-test',
      fxserver: { build: '37175-0105063b0394b1b9d085c917a8dc9c9abf0a620f' },
      resources: [{ name: 'neo', path: 'resources/neo' }],
    });
    expect(config.root).toBe('C:/redm-testbed');
    expect(config.connect).toBe('127.0.0.1:30120');
    expect(config.resources[0]?.category).toBe('[project]');
  });

  it('refuses a build without the commit hash', () => {
    expect(projectConfig.safeParse({ host: 'h', fxserver: { build: '37175' } }).success).toBe(false);
  });
});

describe('protocol helpers', () => {
  it('does not accept prototype keys as method names', () => {
    expect(isMethodName('constructor')).toBe(false);
    expect(isMethodName('server.start')).toBe(true);
  });

  it('makes a safe pipe name', () => {
    expect(pipeName('Yusuf Z')).toBe('\\\\.\\pipe\\redm-testbed-yusuf_z');
  });
});

describe('redact', async () => {
  const { redact } = await import('../src/host/daemon.ts');
  it('hides the bridge payload', () => {
    expect(redact('[rcon]  testbed tb-abc-1 client 1 eyJ0b2tlbiI6InNlY3JldCJ9\n')).toBe('[rcon]  testbed tb-abc-1 client 1 <redacted>\n');
  });
});

describe('key codes', async () => {
  const { keyCode } = await import('../src/protocol/keys.ts');
  it('maps plain and extended keys', () => {
    expect(keyCode('T')).toEqual({ scan: 0x14, extended: false });
    expect(keyCode('enter')).toEqual({ scan: 0x1c, extended: false });
    expect(keyCode('up')).toEqual({ scan: 0x48, extended: true });
  });
  it('maps a chord in order', async () => {
    const { keyChord } = await import('../src/protocol/keys.ts');
    expect(keyChord('ctrl+a')).toEqual([{ scan: 0x1d, extended: false }, { scan: 0x1e, extended: false }]);
    expect(keyChord('slash')).toEqual([{ scan: 0x35, extended: false }]);
    expect(() => keyChord('ctrl+nope')).toThrow();
  });
  it('refuses an unknown key and a prototype key', () => {
    expect(() => keyCode('constructor')).toThrow();
    expect(() => keyCode('nope')).toThrow();
  });
});

describe('extra secrets', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { extraSecrets, secretLine } = await import('../src/host/paths.ts');
  it('reads CFG_ keys with valid convar names only', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')), 'secrets.env');
    fs.writeFileSync(file, 'RCON_PASSWORD=x\nCFG_neo_database_url=postgres://a@b/c\nCFG_bad-name=1\nCFG_1x=2\n');
    const extra = extraSecrets(file);
    expect([...extra.values]).toEqual([['neo_database_url', 'postgres://a@b/c']]);
    expect(extra.skipped).toEqual(['CFG_bad-name', 'CFG_1x']);
  });
  it('refuses a value with a quote or a line break', () => {
    expect(secretLine('a', 'ok')).toBe('set a "ok"');
    expect(() => secretLine('a', 'x" exec evil')).toThrow();
    expect(() => secretLine('a', 'x\nquit')).toThrow();
  });
});
