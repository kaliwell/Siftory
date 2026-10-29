import { createHash } from 'node:crypto'
import type { MigrationProgress } from './storageDirectoryMigration'

const PHASE_LABELS: Record<MigrationProgress['phase'], string> = {
  scanning: '正在统计文件 / Scanning files',
  copying: '正在复制并初步校验 / Copying and checking files',
  'checking-source': '正在复查原目录 / Checking the original directory',
  verifying: '正在最终校验 / Verifying the complete copy',
  committing: '正在确认并切换目录 / Switching data location',
  completed: '迁移完成，即将启动 / Migration completed',
}

function fraction(bytes: number, totalBytes: number, files: number, totalFiles: number) {
  const byFiles = totalFiles > 0 ? files / totalFiles : 1
  const byBytes = totalBytes > 0 ? bytes / totalBytes : byFiles
  // Small files take meaningful time even when the large model files are done.
  return Math.min(1, Math.max(0, (byBytes + byFiles) / 2))
}

export function migrationProgressFraction(value: MigrationProgress): number | null {
  switch (value.phase) {
    case 'scanning':
      return null
    case 'copying':
      return (
        fraction(value.copiedBytes, value.totalBytes, value.copiedFiles, value.totalFiles) * 0.5
      )
    case 'checking-source':
      return 0.5
    case 'verifying':
      return (
        0.5 +
        fraction(value.verifiedBytes, value.totalBytes * 2, value.verifiedFiles, value.totalFiles) *
          0.49
      )
    case 'committing':
      return 0.99
    case 'completed':
      return 1
  }
}

function bytesLabel(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`
}

export function migrationProgressView(value: MigrationProgress) {
  const fraction = migrationProgressFraction(value)
  const count = (n: number) => n.toLocaleString('zh-CN')
  const verification = value.phase === 'verifying' || value.phase === 'committing'
  return {
    phase: PHASE_LABELS[value.phase],
    fraction,
    percentage: fraction === null ? '统计中…' : `${Math.floor(fraction * 100)}%`,
    files:
      value.phase === 'scanning'
        ? `已发现 ${count(value.scannedFiles)} 个文件`
        : value.phase === 'checking-source' || value.phase === 'committing'
          ? `复查文件 ${count(value.scannedFiles)} / ${count(value.totalFiles)}`
          : `${verification ? '已校验' : '已复制'} ${count(verification ? value.verifiedFiles : value.copiedFiles)} / ${count(value.totalFiles)} 个文件`,
    bytes: verification
      ? `校验读取 ${bytesLabel(value.verifiedBytes)} / ${bytesLabel(value.totalBytes * 2)}`
      : value.phase === 'scanning'
        ? `已发现 ${bytesLabel(value.totalBytes)}`
        : `已复制 ${bytesLabel(value.copiedBytes)} / ${bytesLabel(value.totalBytes)}`,
    currentFile: value.currentFile || '正在准备…',
    completed: value.phase === 'completed',
  }
}

export function storageMigrationProgressHtml(): string {
  const style = `
    *{box-sizing:border-box}body{margin:0;padding:28px;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:#192f49;background:#f3f7fb}
    h1{font-size:21px;margin:0 0 3px}p{margin:0;color:#63758a}.card{margin-top:22px;background:#fff;border:1px solid #d8e1ec;border-radius:12px;padding:20px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px}.phase{font-weight:600;font-size:14px}.percent{font-size:21px;font-weight:700;color:#315a85;white-space:nowrap}
    progress{display:block;appearance:none;width:100%;height:10px;margin:16px 0 14px;border:0;border-radius:8px;overflow:hidden;background:#e5edf5;accent-color:#356ca5}
    progress::-webkit-progress-bar{background:#e5edf5;border-radius:8px}progress::-webkit-progress-value{background:#356ca5;border-radius:8px;transition:width .15s}
    .stats{font-size:13px;color:#52657b;flex-wrap:wrap}.path{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr;margin-top:12px;color:#67788b;font-size:12px;min-height:20px}
    .note{font-size:12px;margin-top:16px}.footer{margin-top:22px}.time{font-size:12px;color:#64778c}button{border:1px solid #aabbd0;border-radius:7px;background:white;color:#243f60;padding:8px 16px;font:inherit;cursor:pointer}
    button:hover{background:#e9f0f8}button:focus-visible{outline:2px solid #356ca5;outline-offset:3px}button:disabled{opacity:.6;cursor:default}
  `
  const script = `
    const byId = id => document.getElementById(id);
    const started = Date.now();
    window.updateMigrationProgress = value => {
      byId('phase').textContent = value.phase;
      byId('percent').textContent = value.percentage;
      const bar = byId('progress');
      if (value.fraction === null) bar.removeAttribute('value'); else bar.value = value.fraction;
      byId('files').textContent = value.files;
      byId('bytes').textContent = value.bytes;
      byId('current').textContent = value.currentFile;
      byId('current').title = value.currentFile;
      byId('cancel').disabled = value.completed;
    };
    setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      byId('elapsed').textContent = '已用时 ' + [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':');
    }, 1000);
    byId('cancel').addEventListener('click', () => window.close());
  `
  const hash = (s: string) => createHash('sha256').update(s).digest('base64')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; base-uri 'none'; form-action 'none'">
    <title>Siftory · 数据迁移</title><style>${style}</style></head><body>
    <h1>正在迁移应用数据</h1><p>Application data migration</p>
    <section class="card" aria-label="迁移进度">
      <div class="row"><span class="phase" id="phase">正在统计文件 / Scanning files</span><span class="percent" id="percent">统计中…</span></div>
      <progress id="progress" max="1" aria-label="迁移总进度"></progress>
      <div class="row stats"><span id="files">已发现 0 个文件</span><span id="bytes">已发现 0 B</span></div>
      <div class="path" id="current">正在准备…</div>
    </section>
    <p class="note">请保持磁盘连接。旧数据会保留，完整校验成功后才切换位置。<br>Keep both disks connected. The original data is retained.</p>
    <div class="row footer"><span class="time" id="elapsed">已用时 00:00:00</span><button id="cancel" type="button">取消迁移 / Cancel</button></div>
    <script>${script}</script></body></html>`
}
