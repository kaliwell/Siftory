import { app } from 'electron'
import path from 'path'
import { openControlledMediaPlayer } from '../electron/mediaPlayerService'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void app.whenReady().then(async () => {
  const videoPath = process.argv[2]
  const timestampMs = Number(process.argv[3])
  const projectRoot = process.argv[4]
  const result = await openControlledMediaPlayer(
    {
      videoId: 'smoke-video',
      videoPath,
      title: 'Controlled seek smoke',
      timestampMs,
      durationMs: 3000,
    },
    {
      show: false,
      playerHtmlPath: path.join(projectRoot, 'dist', 'media-player.html'),
      playerPreloadPath: path.join(projectRoot, 'dist-electron', 'mediaPlayerPreload.js'),
    },
  )
  if (!result.ok || !result.window) throw new Error(result.error || 'Player did not open')
  let observed = 0
  for (let attempt = 0; attempt < 40; attempt += 1) {
    observed = await result.window.webContents.executeJavaScript(
      `document.querySelector('video')?.currentTime ?? 0`,
      true,
    )
    if (observed >= timestampMs / 1000) break
    await delay(100)
  }
  const playerUi = await result.window.webContents.executeJavaScript(
    `({
      exportApi: typeof window.siftoryMediaPlayer?.exportSelection,
      start: Boolean(document.querySelector('#clip-start')),
      end: Boolean(document.querySelector('#clip-end')),
      timeline: Boolean(document.querySelector('#selection-track')),
      playhead: Boolean(document.querySelector('#selection-playhead')),
      loop: Boolean(document.querySelector('#loop-selection')),
      startFrameBack: Boolean(document.querySelector('#start-frame-back')),
      startFrameForward: Boolean(document.querySelector('#start-frame-forward')),
      endFrameBack: Boolean(document.querySelector('#end-frame-back')),
      endFrameForward: Boolean(document.querySelector('#end-frame-forward')),
      video: Boolean(document.querySelector('#export-video')),
      edl: Boolean(document.querySelector('#export-edl')),
      fcpxml: Boolean(document.querySelector('#export-fcpxml'))
    })`,
    true,
  )
  const loopUi = await result.window.webContents.executeJavaScript(
    `(() => {
      const player = document.querySelector('video')
      const start = document.querySelector('#clip-start')
      const end = document.querySelector('#clip-end')
      const loop = document.querySelector('#loop-selection')
      player.pause()
      start.value = '0.500'
      start.dispatchEvent(new Event('change', { bubbles: true }))
      end.value = '1.000'
      end.dispatchEvent(new Event('change', { bubbles: true }))
      loop.checked = true
      loop.dispatchEvent(new Event('change', { bubbles: true }))
      player.currentTime = 2
      player.dispatchEvent(new Event('timeupdate'))
      return {
        currentTime: player.currentTime,
        looping: document.querySelector('#selection-track')?.dataset.looping,
        rangeWidth: document.querySelector('#selection-range-fill')?.style.width,
        playheadLeft: document.querySelector('#selection-playhead')?.style.left
      }
    })()`,
    true,
  )
  const precisionUi = await result.window.webContents.executeJavaScript(
    `(() => {
      const start = document.querySelector('#clip-start')
      const end = document.querySelector('#clip-end')
      const loop = document.querySelector('#loop-selection')
      loop.checked = false
      loop.dispatchEvent(new Event('change', { bubbles: true }))
      start.value = '0.480'
      start.dispatchEvent(new Event('change', { bubbles: true }))
      end.value = '1.000'
      end.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('#start-frame-forward').click()
      const startForward = Number(start.value)
      document.querySelector('#start-frame-back').click()
      const startBack = Number(start.value)
      document.querySelector('#end-frame-back').click()
      const endBack = Number(end.value)
      document.querySelector('#end-frame-forward').click()
      const endForward = Number(end.value)
      return {
        startForward,
        startBack,
        endBack,
        endForward,
        startFrame: document.querySelector('#start-frame-value')?.textContent,
        endFrame: document.querySelector('#end-frame-value')?.textContent
      }
    })()`,
    true,
  )
  const ok =
    typeof observed === 'number' &&
    observed >= timestampMs / 1000 &&
    playerUi.exportApi === 'function' &&
    playerUi.start &&
    playerUi.end &&
    playerUi.timeline &&
    playerUi.playhead &&
    playerUi.loop &&
    playerUi.startFrameBack &&
    playerUi.startFrameForward &&
    playerUi.endFrameBack &&
    playerUi.endFrameForward &&
    playerUi.video &&
    playerUi.edl &&
    playerUi.fcpxml &&
    Math.abs(loopUi.currentTime - 0.5) < 0.05 &&
    loopUi.looping === 'true' &&
    Number.parseFloat(loopUi.rangeWidth) > 0 &&
    Number.parseFloat(loopUi.playheadLeft) > 0 &&
    Math.abs(precisionUi.startForward - 0.52) < 0.001 &&
    Math.abs(precisionUi.startBack - 0.48) < 0.001 &&
    Math.abs(precisionUi.endBack - 0.96) < 0.001 &&
    Math.abs(precisionUi.endForward - 1) < 0.001 &&
    precisionUi.startFrame === 'F 000012' &&
    precisionUi.endFrame === 'F 000025'
  process.stdout.write(
    `${JSON.stringify({ ok, timestampMs, observed, playerUi, loopUi, precisionUi })}\n`,
  )
  result.window.destroy()
  app.exit(ok ? 0 : 1)
})
