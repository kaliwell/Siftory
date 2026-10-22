const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('global shortcut contract keeps R primary, Q compatible, and P for panel snap', () => {
  const main = source('electron/appCoreIpc.ts')
  const settings = source('src/components/SettingsPanel.tsx')
  const manual = source('docs/reference/user-manual.md')

  assert.match(main, /toggle-primary'[\s\S]*CommandOrControl\+Shift\+Alt\+R/)
  assert.match(main, /toggle-legacy'[\s\S]*CommandOrControl\+Shift\+Alt\+Q/)
  assert.match(main, /snap-panels'[\s\S]*CommandOrControl\+Shift\+Alt\+P/)
  assert.match(main, /lastGlobalToggleAt = now[\s\S]*if \(repeated\) \{[\s\S]*hotkey-repeat/)
  assert.match(settings, /Ctrl\+Shift\+Alt\+R — \{t\('Toggle visibility'\)\}/)
  assert.match(settings, /hotkeyConflicts\.map/)
  assert.match(manual, /`Ctrl\+Shift\+Alt\+R` \| 隐藏或恢复工作区（主快捷键）/)
})

test('standard windows hide and reveal natively while diagnostic overlays retain their handshake', () => {
  const core = source('electron/appCoreIpc.ts')
  const main = source('electron/main.ts')
  const app = source('src/App.tsx')

  const hideBlock = core.slice(
    core.indexOf('export function setGlobalWindowVisibility'),
    core.indexOf('export function revealGlobalWindow'),
  )
  assert.ok(
    hideBlock.indexOf('applyMouseTransparency(mainWindow, true)') <
      hideBlock.indexOf('setOpacity(0)'),
  )
  assert.ok(
    hideBlock.indexOf('applyWindowShape(mainWindow, [])') < hideBlock.indexOf('setOpacity(0)'),
  )
  const standardBlock = hideBlock.slice(
    hideBlock.indexOf('if (options.standardWindow)'),
    hideBlock.indexOf('const previousSnapshot'),
  )
  assert.match(standardBlock, /mainWindow\.setOpacity\(1\)/)
  assert.match(standardBlock, /applyMouseTransparency\(mainWindow, false\)/)
  assert.match(standardBlock, /mainWindow\.hide\(\)/)
  assert.match(standardBlock, /mainWindow\.show\(\)/)
  assert.match(standardBlock, /mainWindow\.focus\(\)/)
  assert.doesNotMatch(standardBlock, /applyWindowShape|setOpacity\(0\)/)
  assert.match(
    core,
    /completeGlobalWindowReveal[\s\S]*snapshot\.state === 'visible'[\s\S]*return true/,
  )
  assert.match(core, /setBackgroundThrottling\(false\)[\s\S]*send\('show-global-visibility'/)
  assert.match(
    core,
    /prewarmGlobalWindowShow[\s\S]*setOpacity\(WINDOW_PREWARM_OPACITY\)[\s\S]*if \(!mainWindow\.isVisible\(\)\)[\s\S]*showInactive\(\)[\s\S]*global-window-shown-for-paint/,
  )
  assert.match(
    core,
    /completeGlobalWindowReveal[\s\S]*setOpacity\(visibleWindowOpacity\)[\s\S]*setBackgroundThrottling\(false\)/,
  )
  assert.equal((core.match(/mainWindow\.showInactive\(\)/g) ?? []).length, 1)
  assert.doesNotMatch(main, /mainWindow\.on\('show'/)

  assert.match(main, /standardWindow: !uiSmokeMode/)
  assert.match(app, /const applyNativeVisibility = \(event: WindowVisibilityEvent\)/)
  assert.match(app, /const visible =\s*event\.state === 'visible'/)
  assert.equal((app.match(/applyNativeVisibility\(event\)/g) ?? []).length, 2)
  assert.doesNotMatch(app, /setOverlayShape\(|useMouseTransparency\(|scheduleVisibilityPaintTurn/)
})

test('stale shape and mouse requests are generation guarded', () => {
  const core = source('electron/appCoreIpc.ts')
  const preload = source('electron/preload.ts')
  const api = source('shared/ipc/electron-api.ts')

  assert.match(core, /set-ignore-mouse[\s\S]*acceptsRendererMutation\(generation\)/)
  assert.match(core, /set-overlay-shape[\s\S]*acceptsRendererMutation\(generation\)/)
  assert.match(preload, /setIgnoreMouseEvents: \(ignore, generation\)/)
  assert.match(preload, /setOverlayShape: \(rects, generation\)/)
  assert.match(api, /setIgnoreMouseEvents: \(ignore: boolean, generation: number\)/)
  assert.match(api, /setOverlayShape:\s*\([\s\S]*?generation: number/)
  assert.match(api, /showWindow: \(generation: number\) => Promise<boolean>/)
  assert.match(preload, /revealWindow: \(generation\)/)
  assert.match(api, /revealWindow: \(generation: number\) => Promise<boolean>/)
})

test('mouse transparency commits after IPC success and all drags have cancellation paths', () => {
  const hook = source('src/hooks/useMouseTransparency.ts')
  const panel = source('src/components/DraggablePanel.tsx')
  const navigator = source('src/components/WorkspaceNavigator.tsx')

  const flush = hook.slice(
    hook.indexOf('const flush = async'),
    hook.indexOf('const requestInteractive'),
  )
  assert.ok(
    flush.indexOf('await window.electronAPI.setIgnoreMouseEvents') <
      flush.indexOf('appliedInteractive = generation === visibilityGeneration()'),
  )
  assert.match(flush, /retryDelayMs = Math\.min\(400, retryDelayMs \* 2\)/)
  assert.doesNotMatch(hook, /THROTTLE_MS|50\s*ms/)
  assert.match(hook, /window-visibility-state/)
  assert.match(panel, /window-visibility-cancel-interactions/)
  assert.match(panel, /window\.addEventListener\('blur'/)
  assert.doesNotMatch(navigator, /onMouseDown=\{startMove\}/)
  assert.doesNotMatch(navigator, /workspace-window-hide|workspace-window-pin/)
  assert.doesNotMatch(source('src/App.tsx'), /useMouseTransparency\(/)
})

test('real Electron UI smoke executes repeated native hide and renderer-ready show cycles', () => {
  const main = source('electron/main.ts')
  const smoke = source('electron/uiSmokeService.ts')

  assert.match(main, /setWindowVisibility: \(visible\)[\s\S]*setGlobalWindowVisibility/)
  assert.match(
    smoke,
    /requestedCycles: options\.setWindowVisibility \? options\.visibilityCycles \|\| 0 : 0/,
  )
  assert.match(smoke, /waitForNativeVisibility\(window, false\)/)
  assert.match(smoke, /waitForNativeVisibility\(window, true\)/)
  assert.match(smoke, /window\.getOpacity\(\) <= 0\.001/)
  assert.match(smoke, /panelsReadyOnShow/)
  assert.match(smoke, /interactionCancelledOnHide/)
  assert.match(smoke, /p95ShowLatencyMs <= 120/)
  assert.match(smoke, /p99ShowLatencyMs <= 200/)
  assert.match(smoke, /visibleFrameCadence\.fps >= 30/)
  assert.match(smoke, /visibilityCycleCheck\.rendererMetrics\.delta/)
  assert.match(
    smoke,
    /visibilityCycleCheck\.completedCycles === visibilityCycleCheck\.requestedCycles/,
  )
})
