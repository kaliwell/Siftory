const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

// Compiled beside the real helper class. This adapter records only in-memory
// calls; none of these fault scenarios invokes a desktop/window/input API.
const fakeNativeHarness = `
public sealed class SiftoryFakeInput : SiftoryWindowInput.NativeInput {
  public SiftoryWindowInput.Point Position = new SiftoryWindowInput.Point { X = 10, Y = 20 };
  public bool ReadOk = true;
  public bool MoveOk = true;
  public int Moves;
  public System.Collections.Generic.Queue<uint> Results = new System.Collections.Generic.Queue<uint>();
  public System.Collections.Generic.List<string> Sends = new System.Collections.Generic.List<string>();
  public bool ReadCursor(out SiftoryWindowInput.Point point) { point = Position; return ReadOk; }
  public bool MoveCursor(SiftoryWindowInput.Point point) { Moves++; if (MoveOk) Position = point; return MoveOk; }
  public long OwnedTarget(SiftoryWindowInput.Point point, int process, long first, long second) { return first; }
  public long Foreground() { return 101; }
  public bool Activate(long target) { return true; }
  public bool LeftButtonDown() { return false; }
  public uint Send(SiftoryWindowInput.Input[] inputs) {
    var flags = new System.Collections.Generic.List<string>();
    foreach (var input in inputs) flags.Add(input.data.mouse.flags.ToString());
    Sends.Add(string.Join(",", flags.ToArray()));
    return Results.Dequeue();
  }
}
public static class SiftoryInputFaultHarness {
  static object Partial(string name, uint[] results) {
    var native = new SiftoryFakeInput();
    foreach (uint result in results) native.Results.Enqueue(result);
    var session = new SiftoryWindowInput.Session(native);
    session.Prepare(90, 100, 42, 101, 102);
    string error = "";
    try { session.Click(42, 101, 102); } catch (System.Exception failure) { error = failure.Message; }
    int movesBeforeCleanup = native.Moves;
    string cleanup = session.Restore();
    string again = session.Restore();
    return new System.Collections.Generic.Dictionary<string, object> {
      { "name", name }, { "error", error }, { "cleanup", cleanup }, { "again", again },
      { "movesBeforeCleanup", movesBeforeCleanup }, { "moves", native.Moves },
      { "position", new int[] { native.Position.X, native.Position.Y } }, { "sends", native.Sends.ToArray() }
    };
  }
  static object Restoration(string name) {
    var native = new SiftoryFakeInput();
    var session = new SiftoryWindowInput.Session(native);
    session.Prepare(90, 100, 42, 101, 102);
    if (name == "read-failed") native.ReadOk = false;
    if (name == "restore-failed") native.MoveOk = false;
    if (name == "user-moved") native.Position = new SiftoryWindowInput.Point { X = 123, Y = 234 };
    return new System.Collections.Generic.Dictionary<string, object> {
      { "name", name }, { "cleanup", session.Restore() }, { "moves", native.Moves },
      { "position", new int[] { native.Position.X, native.Position.Y } }, { "sends", native.Sends.ToArray() }
    };
  }
  public static object[] Run() {
    return new object[] {
      Partial("compensated", new uint[] { 1, 1 }),
      Partial("release-failed", new uint[] { 1, 0, 0 }),
      Partial("cleanup-release-recovered", new uint[] { 1, 0, 1 }),
      Restoration("read-failed"), Restoration("restore-failed"), Restoration("user-moved")
    };
  }
}
`

test(
  'native helper has the platform INPUT layout and rejects commands without a valid fixture',
  {
    skip: process.platform !== 'win32',
    timeout: 20_000,
  },
  () => {
    const script = fs.readFileSync(
      path.join(__dirname, 'window-visibility-native-input.ps1'),
      'utf8',
    )
    // Invalid fixture identifiers reject preparation before any cursor/window API;
    // unprepared clicks reject before SendInput. This test opens no windows.
    const requests = [
      { command: 'click' },
      { command: 'prepare', x: 0, y: 0 },
      { command: 'click' },
      { command: 'unknown' },
      { command: 'restore' },
    ]
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `& {${script}\n} -FixtureProcessId 0 -SentinelHandle 0 -OverlayHandle 0`,
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
        timeout: 15_000,
      },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const [layout, ...responses] = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    assert.equal(layout.ready, true)
    assert.ok([4, 8].includes(layout.pointerSize))
    assert.equal(layout.inputSize, layout.pointerSize === 8 ? 40 : 28)
    assert.equal(layout.unionOffset, layout.pointerSize === 8 ? 8 : 4)
    assert.equal(layout.perMonitorDpi, true)
    assert.deepEqual(responses, [
      { ok: false, error: 'no-prepared-target' },
      { ok: false, error: 'invalid-fixture-target' },
      { ok: false, error: 'no-prepared-target' },
      { ok: false, error: 'invalid-fixture-command' },
      { ok: true, restored: false, status: 'no-pending-target' },
    ])
  },
)

test(
  'real native session bounds partial-input release and distinguishes restore failures from movement',
  { skip: process.platform !== 'win32', timeout: 20_000 },
  () => {
    const script = fs.readFileSync(
      path.join(__dirname, 'window-visibility-native-input.ps1'),
      'utf8',
    )
    const embedded = script.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)
    assert.ok(embedded, 'the tested C# must come from the actual helper')
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${embedded[1]}\n${fakeNativeHarness}\n'@\n[SiftoryInputFaultHarness]::Run() | ConvertTo-Json -Depth 6 -Compress`,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const cases = Object.fromEntries(JSON.parse(result.stdout).map((item) => [item.name, item]))
    assert.deepEqual(cases.compensated, {
      name: 'compensated',
      error: 'input-unavailable',
      cleanup: 'restored',
      again: 'no-pending-target',
      movesBeforeCleanup: 1,
      moves: 2,
      position: [10, 20],
      sends: ['2,4', '4'],
    })
    assert.deepEqual(cases['release-failed'], {
      name: 'release-failed',
      error: 'mouse-release-failed',
      cleanup: 'mouse-release-failed',
      again: 'mouse-release-failed',
      movesBeforeCleanup: 1,
      moves: 1,
      position: [90, 100],
      sends: ['2,4', '4', '4'],
    })
    assert.deepEqual(cases['cleanup-release-recovered'], {
      name: 'cleanup-release-recovered',
      error: 'mouse-release-failed',
      cleanup: 'restored',
      again: 'no-pending-target',
      movesBeforeCleanup: 1,
      moves: 2,
      position: [10, 20],
      sends: ['2,4', '4', '4'],
    })
    assert.deepEqual(cases['read-failed'], {
      name: 'read-failed',
      cleanup: 'cursor-read-failed',
      moves: 1,
      position: [90, 100],
      sends: [],
    })
    assert.deepEqual(cases['restore-failed'], {
      name: 'restore-failed',
      cleanup: 'cursor-restore-failed',
      moves: 2,
      position: [90, 100],
      sends: [],
    })
    assert.deepEqual(cases['user-moved'], {
      name: 'user-moved',
      cleanup: 'cursor-moved-before-restoration',
      moves: 1,
      position: [123, 234],
      sends: [],
    })
  },
)
