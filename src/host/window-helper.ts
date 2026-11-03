// Window tools through one long-running PowerShell process (SPEC-0001 D10).
// The daemon runs in the interactive session (D3), so the helper can read and drive the game window.
// The script is a string here, so `tsc` output contains it without a copy step.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { asciiJson, LineSplitter } from '../protocol/rpc.ts';

const CSHARP = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class Testbed {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4, KEYEVENTF_SCANCODE = 0x8;

  public static IntPtr GameWindow() {
    foreach (Process p in Process.GetProcesses()) {
      try {
        string name = p.ProcessName;
        if (name.StartsWith("RedM_", StringComparison.OrdinalIgnoreCase) && name.EndsWith("GTAProcess", StringComparison.OrdinalIgnoreCase) && p.MainWindowHandle != IntPtr.Zero)
          return p.MainWindowHandle;
      } catch { }
    }
    return IntPtr.Zero;
  }

  static IntPtr Require() {
    IntPtr h = GameWindow();
    if (h == IntPtr.Zero) throw new Exception("the game window was not found (is RedM running?)");
    return h;
  }

  public static bool IsFocused() { IntPtr h = GameWindow(); return h != IntPtr.Zero && GetForegroundWindow() == h; }

  public static string Title() {
    IntPtr h = GameWindow();
    foreach (Process p in Process.GetProcesses()) { try { if (p.MainWindowHandle == h) return p.MainWindowTitle; } catch { } }
    return "";
  }

  public static Rectangle ClientRect() {
    IntPtr h = Require();
    RECT r; GetClientRect(h, out r);
    POINT origin = new POINT(); ClientToScreen(h, ref origin);
    return new Rectangle(origin.X, origin.Y, r.Right - r.Left, r.Bottom - r.Top);
  }

  // Windows lets a process take the foreground only after input; an ALT tap gives that right.
  public static bool Focus() {
    IntPtr h = Require();
    if (GetForegroundWindow() == h) return true;
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    SetForegroundWindow(h);
    Thread.Sleep(150);
    return GetForegroundWindow() == h;
  }

  public static string Screenshot(int maxSide, int cx, int cy, int cw, int ch, out int width, out int height) {
    Focus();
    Thread.Sleep(100);
    Rectangle area = ClientRect();
    if (cw > 0 && ch > 0) area = new Rectangle(area.X + cx, area.Y + cy, Math.Min(cw, area.Width - cx), Math.Min(ch, area.Height - cy));
    if (area.Width <= 0 || area.Height <= 0) throw new Exception("the capture area is empty");
    using (Bitmap full = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(area.Location, Point.Empty, area.Size);
      double scale = Math.Min(1.0, (double)maxSide / Math.Max(area.Width, area.Height));
      width = Math.Max(1, (int)(area.Width * scale));
      height = Math.Max(1, (int)(area.Height * scale));
      using (Bitmap small = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(small)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.DrawImage(full, 0, 0, width, height);
        }
        using (MemoryStream ms = new MemoryStream()) { small.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
      }
    }
  }

  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new Exception("SendInput failed (is the desktop locked?)");
  }

  static INPUT Key(ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }

  public static void PressKey(int scan, bool extended, int holdMs) {
    Focus();
    uint flags = KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
    Send(new INPUT[] { Key((ushort)scan, flags) });
    Thread.Sleep(Math.Max(holdMs, 30));
    Send(new INPUT[] { Key((ushort)scan, flags | KEYEVENTF_KEYUP) });
  }

  public static void PressChord(int[] scans, bool[] extended, int holdMs) {
    Focus();
    for (int k = 0; k < scans.Length; k++) {
      Send(new INPUT[] { Key((ushort)scans[k], KEYEVENTF_SCANCODE | (extended[k] ? KEYEVENTF_EXTENDEDKEY : 0)) });
      Thread.Sleep(20);
    }
    Thread.Sleep(Math.Max(holdMs, 30));
    for (int k = scans.Length - 1; k >= 0; k--) {
      Send(new INPUT[] { Key((ushort)scans[k], KEYEVENTF_SCANCODE | (extended[k] ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP) });
      Thread.Sleep(20);
    }
  }

  public static void TypeText(string text) {
    Focus();
    foreach (char c in text) {
      Send(new INPUT[] { Key(c, KEYEVENTF_UNICODE), Key(c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) });
      Thread.Sleep(10);
    }
  }

  static INPUT Mouse(int dx, int dy, uint data, uint flags) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i;
  }

  public static void MouseMove(int dx, int dy) { Focus(); Send(new INPUT[] { Mouse(dx, dy, 0, 0x0001) }); }

  public static void MousePosition(int x, int y) {
    Focus();
    Rectangle area = ClientRect();
    SetCursorPos(area.X + x, area.Y + y);
  }

  public static void Click(bool right) {
    Focus();
    Send(new INPUT[] { Mouse(0, 0, 0, right ? 0x0008u : 0x0002u) });
    Thread.Sleep(40);
    Send(new INPUT[] { Mouse(0, 0, 0, right ? 0x0010u : 0x0004u) });
  }

  public static void Scroll(int amount) { Focus(); Send(new INPUT[] { Mouse(0, 0, (uint)(amount * 120), 0x0800) }); }
}
`;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${CSHARP}
'@
[void][Testbed]::SetProcessDPIAware()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $data = @{}
    switch ($req.op) {
      'status' {
        $found = [Testbed]::GameWindow() -ne [IntPtr]::Zero
        $data = @{ found = $found; focused = [Testbed]::IsFocused() }
        if ($found) {
          $r = [Testbed]::ClientRect()
          $data.title = [Testbed]::Title()
          $data.rect = @{ x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height }
        }
      }
      'screenshot' {
        $w = 0; $h = 0
        $png = [Testbed]::Screenshot([int]$req.maxSide, [int]$req.x, [int]$req.y, [int]$req.width, [int]$req.height, [ref]$w, [ref]$h)
        $data = @{ png = $png; width = $w; height = $h }
      }
      'key' { [Testbed]::PressKey([int]$req.scan, [bool]$req.extended, [int]$req.holdMs) }
      'chord' { [Testbed]::PressChord([int[]]$req.scans, [bool[]]$req.extended, [int]$req.holdMs) }
      'text' { [Testbed]::TypeText([string]$req.text) }
      'move' { [Testbed]::MouseMove([int]$req.dx, [int]$req.dy) }
      'position' { [Testbed]::MousePosition([int]$req.x, [int]$req.y) }
      'click' { [Testbed]::Click($req.button -eq 'right') }
      'scroll' { [Testbed]::Scroll([int]$req.amount) }
      default { throw "unknown op $($req.op)" }
    }
    $out = @{ id = $req.id; ok = $true; data = $data }
  } catch {
    $out = @{ id = $(if ($req) { $req.id } else { 0 }); ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
`;

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class WindowHelper {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const splitter = new LineSplitter();
    let stderr = '';
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the window helper did not start in 30 s')), 30_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) {
          let message: { ready?: boolean; id?: number; ok?: boolean; data?: unknown; error?: string };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
          if (!pending || message.id === undefined) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.data);
          else pending.reject(new Error(message.error ?? 'window helper error'));
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const error = new Error(`the window helper exited (code ${code}): ${stderr.trim().slice(-500)}`);
        reject(error);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (this.child === child) {
          this.child = undefined;
          this.ready = undefined;
        }
      });
    });
    return this.ready;
  }

  async request(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error('the window helper is not running');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the window helper gave no answer to ${op} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${asciiJson({ ...args, id, op })}\n`);
    });
  }

  stop(): void {
    this.child?.kill();
  }
}
