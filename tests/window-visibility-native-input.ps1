param([int]$FixtureProcessId, [long]$SentinelHandle, [long]$OverlayHandle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SiftoryWindowInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MouseInput mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public InputUnion data; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);

  // Tests instantiate a separate Session with a fake native adapter. The command
  // protocol always uses this real Win32 adapter; there is no skip/override flag.
  public interface NativeInput {
    bool ReadCursor(out Point point);
    bool MoveCursor(Point point);
    long OwnedTarget(Point point, int process, long first, long second);
    long Foreground();
    bool Activate(long target);
    bool LeftButtonDown();
    uint Send(Input[] inputs);
  }
  sealed class Win32Input : NativeInput {
    public bool ReadCursor(out Point point) { return GetCursorPos(out point); }
    public bool MoveCursor(Point point) { return SetCursorPos(point.X, point.Y); }
    public long OwnedTarget(Point point, int process, long first, long second) {
      IntPtr target = GetAncestor(WindowFromPoint(point), 2);
      uint owner; GetWindowThreadProcessId(target, out owner);
      long handle = target.ToInt64();
      return owner == process && (handle == first || handle == second) ? handle : 0;
    }
    public long Foreground() { return GetForegroundWindow().ToInt64(); }
    public bool Activate(long target) { return SetForegroundWindow(new IntPtr(target)); }
    public bool LeftButtonDown() { return (GetAsyncKeyState(1) & 0x8000) != 0; }
    public uint Send(Input[] inputs) { return SendInput((uint)inputs.Length, inputs, InputSize()); }
  }
  public sealed class Session {
    readonly NativeInput native;
    Point previous;
    Point pendingPoint;
    bool pending;
    bool fixtureButtonDown;
    int releaseAttempts;
    public Session(NativeInput adapter) { native = adapter; }
    static Input Button(uint flags) {
      return new Input { type = 0, data = new InputUnion { mouse = new MouseInput { flags = flags } } };
    }
    public bool CursorAtTarget() {
      Point point;
      if (!native.ReadCursor(out point)) throw new Exception("cursor-read-failed");
      return point.X == pendingPoint.X && point.Y == pendingPoint.Y;
    }
    public int[] CursorDelta() {
      Point point;
      if (!native.ReadCursor(out point)) throw new Exception("cursor-read-failed");
      return new int[] { point.X - pendingPoint.X, point.Y - pendingPoint.Y };
    }
    public int Foreground(long first, long second) {
      long window = native.Foreground();
      return window == first ? 0 : window == second ? 1 : -1;
    }
    int Guard(int process, long first, long second) {
      if (fixtureButtonDown) throw new Exception("mouse-release-failed");
      if (!pending) throw new Exception("no-prepared-target");
      if (!CursorAtTarget()) throw new Exception("cursor-moved-before-click");
      long target = native.OwnedTarget(pendingPoint, process, first, second);
      if (target == 0) throw new Exception("foreign-window-at-click-point");
      if (native.Foreground() != target) throw new Exception("fixture-not-foreground");
      return target == first ? 0 : 1;
    }
    public int Prepare(int x, int y, int process, long first, long second) {
      if (process <= 0 || first <= 0 || second <= 0 || first == second || pending || fixtureButtonDown)
        throw new Exception("invalid-fixture-target");
      if (native.LeftButtonDown()) throw new Exception("mouse-button-already-held");
      if (!native.ReadCursor(out previous)) throw new Exception("cursor-read-failed");
      pendingPoint = new Point { X = x, Y = y };
      pending = true;
      if (!native.MoveCursor(pendingPoint)) throw new Exception("cursor-unavailable");
      long target = native.OwnedTarget(pendingPoint, process, first, second);
      if (target == 0) throw new Exception("foreign-window-at-click-point");
      // Request activation only for the verified fixture HWND. Never attach to
      // or manipulate another app, and respect foreground-lock refusal.
      if (native.Foreground() != target && !native.Activate(target))
        throw new Exception("fixture-activation-refused");
      return Guard(process, first, second);
    }
    bool ReleaseFixtureButton() {
      if (!fixtureButtonDown) return true;
      // One immediate compensation and at most one later cleanup attempt.
      if (releaseAttempts >= 2) return false;
      releaseAttempts++;
      if (native.Send(new Input[] { Button(4) }) != 1) return false;
      fixtureButtonDown = false;
      return true;
    }
    public int Click(int process, long first, long second) {
      int recipient = Guard(process, first, second);
      if (native.LeftButtonDown()) throw new Exception("mouse-button-already-held");
      uint sent = native.Send(new Input[] { Button(2), Button(4) });
      if (sent != 2) {
        if (sent == 1) {
          fixtureButtonDown = true;
          releaseAttempts = 0;
          if (!ReleaseFixtureButton()) throw new Exception("mouse-release-failed");
        }
        throw new Exception("input-unavailable");
      }
      return recipient;
    }
    public string Restore() {
      // Keep the pointer stationary while our injected down is unresolved.
      if (!ReleaseFixtureButton()) return "mouse-release-failed";
      if (!pending) return "no-pending-target";
      pending = false;
      Point point;
      if (!native.ReadCursor(out point)) return "cursor-read-failed";
      // Only a successful coordinate read can establish user pointer movement.
      if (point.X != pendingPoint.X || point.Y != pendingPoint.Y)
        return "cursor-moved-before-restoration";
      return native.MoveCursor(previous) ? "restored" : "cursor-restore-failed";
    }
  }
  static readonly Session current = new Session(new Win32Input());
  public static int InputSize() { return Marshal.SizeOf(typeof(Input)); }
  public static int UnionOffset() { return Marshal.OffsetOf(typeof(Input), "data").ToInt32(); }
  public static bool ConfigureDpi() { return SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero; }
  public static bool CursorAtTarget() { return current.CursorAtTarget(); }
  public static int[] CursorDelta() { return current.CursorDelta(); }
  public static int Foreground(long first, long second) { return current.Foreground(first, second); }
  public static int Prepare(int x, int y, int process, long first, long second) { return current.Prepare(x, y, process, first, second); }
  public static int Click(int process, long first, long second) { return current.Click(process, first, second); }
  public static string Restore() { return current.Restore(); }
}
'@
@{ ready = $true; pointerSize = [IntPtr]::Size; inputSize = [SiftoryWindowInput]::InputSize(); unionOffset = [SiftoryWindowInput]::UnionOffset(); perMonitorDpi = [SiftoryWindowInput]::ConfigureDpi() } | ConvertTo-Json -Compress
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      if ($request.command -eq 'restore') {
        $status = [SiftoryWindowInput]::Restore()
        if ($status -eq 'restored' -or $status -eq 'no-pending-target') {
          @{ ok = $true; restored = ($status -eq 'restored'); status = $status } | ConvertTo-Json -Compress
        } else {
          @{ ok = $false; error = $status } | ConvertTo-Json -Compress
        }
      } elseif ($request.command -eq 'prepare') {
        $recipient = [SiftoryWindowInput]::Prepare([int]$request.x, [int]$request.y, $FixtureProcessId, $SentinelHandle, $OverlayHandle)
        @{ ok = $true; recipient = $recipient; cursorAtTarget = [SiftoryWindowInput]::CursorAtTarget() } | ConvertTo-Json -Compress
      } elseif ($request.command -eq 'click') {
        $recipient = [SiftoryWindowInput]::Click($FixtureProcessId, $SentinelHandle, $OverlayHandle)
        @{ ok = $true; recipient = $recipient; cursorAtTarget = [SiftoryWindowInput]::CursorAtTarget(); cursorDelta = [SiftoryWindowInput]::CursorDelta(); foreground = [SiftoryWindowInput]::Foreground($SentinelHandle, $OverlayHandle) } | ConvertTo-Json -Compress
      } else {
        throw 'invalid-fixture-command'
      }
    } catch {
      $reason = 'native-click-rejected'
      foreach ($code in @('foreign-window-at-click-point', 'input-unavailable', 'cursor-unavailable', 'cursor-read-failed', 'mouse-release-failed', 'fixture-not-foreground', 'fixture-activation-refused', 'cursor-moved-before-click', 'mouse-button-already-held', 'no-prepared-target', 'invalid-fixture-command', 'invalid-fixture-target')) {
        if ($_.Exception.Message.Contains($code)) { $reason = $code }
      }
      @{ ok = $false; error = $reason } | ConvertTo-Json -Compress
    }
  }
} finally {
  $cleanup = [SiftoryWindowInput]::Restore()
  if ($cleanup -eq 'mouse-release-failed' -or $cleanup -eq 'cursor-read-failed' -or $cleanup -eq 'cursor-restore-failed') {
    @{ ok = $false; error = $cleanup; stage = 'cleanup' } | ConvertTo-Json -Compress
    exit 1
  }
}
