#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const IDS = [
  'llama-cpp-b10441-windows-x64-managed-video-runtime-candidate',
  'qwen3-vl-2b-instruct-q4-k-m-gguf-managed-runtime-candidate',
]

function renderApprovalPacket(projectRoot = path.resolve(__dirname, '..')) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
  )
  const decisions = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'legal', 'license-decisions.json'), 'utf8'),
  )
  const components = IDS.map((id) => manifest.components.find((entry) => entry.id === id))
  if (components.some((entry) => !entry))
    throw new Error('VID-017 candidate missing from runtime manifest')
  const rows = components
    .map(
      (entry) =>
        `| ${entry.upstream.name} | ${entry.upstream.version} | ${entry.license.spdx} | ${entry.license.reviewStatus} | 否 |`,
    )
    .join('\n')
  return `# VID-017 分发审批材料包\n\n> 状态：当前  \n> 更新日期：2026-08-17  \n> 范围：llama.cpp 与 Qwen3-VL 候选分发决策材料  \n> 替代文档：无\n\n> 本文档由固定清单生成，不构成批准，不修改许可证决策。\n\n## 候选组件\n\n| 组件 | 固定版本 | SPDX | 当前审查状态 | 默认打包 |\n| --- | --- | --- | --- | --- |\n${rows}\n\n本地验证已覆盖真实推理、严格 JSON、持续推理和 online/offline 排除矩阵；本地安装范围仍为 \`local-evaluation-only\`。项目许可证当前状态：\`${decisions.project?.status || 'unknown'}\`，表达式：\`${decisions.project?.licenseExpression || 'UNLICENSED'}\`。\n\n## 分发选项\n\n1. 保持用户本机安装、不随应用分发（当前推荐，零新增安装包体积）。\n2. 获批后首次运行在线下载，并提供 MIT、Apache-2.0 许可证及 NOTICE。\n3. 获批后离线内置，安装包预计增加约 1.55 GB，并执行真实 packaged matrix。\n\n## 有权审核人必须完成\n\n- [ ] 确认项目 EULA、版权主体与发布权限。\n- [ ] 确认 llama.cpp MIT 再分发义务和许可证文件。\n- [ ] 确认 Qwen3-VL Apache-2.0/模型材料的再分发范围和 NOTICE。\n- [ ] 在 \`legal/license-decisions.json\` 留下真实审核人、时间、证据和允许的 profile。\n\n在以上条目完成前，\`VAL-313\` 保持 blocked，runtime 与模型不得进入安装包。\n`
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const output = path.join(
    projectRoot,
    'docs',
    'current',
    '2026-08-15-vid-017-distribution-approval-packet.md',
  )
  const rendered = renderApprovalPacket(projectRoot)
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== rendered)
      throw new Error('VID-017 approval packet is stale')
  } else fs.writeFileSync(output, rendered, 'utf8')
  process.stdout.write(`${output}\n`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
module.exports = { renderApprovalPacket }
