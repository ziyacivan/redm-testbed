// Keyboard scan codes (set 1) for the window tools (SPEC-0001 D10).
// RDR2 reads DirectInput scan codes and ignores virtual-key-only input.
export interface KeyCode {
  scan: number;
  extended: boolean;
}

const plain: Record<string, number> = {
  esc: 0x01, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b,
  minus: 0x0c, equals: 0x0d, backspace: 0x0e, tab: 0x0f,
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19,
  enter: 0x1c, ctrl: 0x1d,
  a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  shift: 0x2a,
  z: 0x2c, x: 0x2d, c: 0x2e, v: 0x2f, b: 0x30, n: 0x31, m: 0x32,
  rshift: 0x36, alt: 0x38, space: 0x39, capslock: 0x3a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
};

const extended: Record<string, number> = {
  up: 0x48, left: 0x4b, right: 0x4d, down: 0x50,
  home: 0x47, end: 0x4f, pageup: 0x49, pagedown: 0x51, insert: 0x52, delete: 0x53,
};

export const KEY_NAMES = [...Object.keys(plain), ...Object.keys(extended)] as [string, ...string[]];

export function keyCode(name: string): KeyCode {
  const key = name.toLowerCase();
  if (Object.hasOwn(plain, key)) return { scan: plain[key] as number, extended: false };
  if (Object.hasOwn(extended, key)) return { scan: extended[key] as number, extended: true };
  throw new Error(`unknown key '${name}'. Known keys: ${KEY_NAMES.join(', ')}`);
}
