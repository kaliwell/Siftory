export type IpcCapability = 'R' | 'W' | 'FS' | 'EXT' | 'PROC' | 'NET' | 'SECRET'

export interface IpcCapabilityDeclaration {
  channel: string
  capabilities: readonly IpcCapability[]
  validator: 'bounded-structured-clone-v1'
}

const CORE_CHANNELS = new Set([
  'open-folder',
  'app:openThirdPartyLicenses',
  'app:viewEndUserTerms',
  'terms:get',
  'terms:accept',
  'terms:close',
  'copy-to-clipboard',
  'browse-folder',
  'hide-window',
  'show-window',
  'reveal-window',
  'get-window-always-on-top',
  'set-window-always-on-top',
  'set-transparency',
  'set-ignore-mouse',
  'set-overlay-shape',
  'get-hotkey-status',
  'register-hotkey',
  'unregister-hotkey',
  'load-settings',
  'save-settings',
  'load-config',
  'save-config',
  'get-work-area',
  'get-display-topology',
  'set-display-scope',
  'open-config-dir',
  'fileDrag:start',
  'aiControl:getSettings',
  'aiControl:setEnabled',
  'aiControl:rotateToken',
  'aiControl:getAudit',
  'aiControl:getConfirmations',
  'aiControl:resolveConfirmation',
])

const DOMAIN_PREFIXES = new Set([
  'appStorage',
  'assetFeedback',
  'assetLibrary',
  'batchRename',
  'catalog',
  'duplicates',
  'imageSearch',
  'mediaSearch',
  'remoteTerminal',
  'sourceDerivedData',
  'sam',
  'sources',
  'subject',
  'subjectSearch',
  'vector',
  'videoIndex',
])

const WRITE_OPERATION =
  /(?:^|:|-)(?:abort|apply|archive|assign|build|cancel|clear|compact|connect|copy|create|delete|disconnect|download|execute|extract|import|load|merge|move|paste|pause|purge|rebuild|register|remove|rename|repair|resize|restore|resume|save|scan|set|split|start|stop|sync|undo|unregister|unwatch|update|upload|watch|write)/i
const EXTERNAL_OPERATION = /(?:open|reveal|browse|select|clipboard|drag|explorer|dialog)/i
const PROCESS_DOMAINS = new Set([
  'assetFeedback',
  'assetLibrary',
  'batchRename',
  'duplicates',
  'imageSearch',
  'mediaSearch',
  'remoteTerminal',
  'sourceDerivedData',
  'sam',
  'subject',
  'subjectSearch',
  'vector',
  'videoIndex',
])
const FILESYSTEM_DOMAINS = new Set([
  'appStorage',
  'assetFeedback',
  'assetLibrary',
  'batchRename',
  'catalog',
  'duplicates',
  'imageSearch',
  'mediaSearch',
  'remoteTerminal',
  'sourceDerivedData',
  'sam',
  'sources',
  'subject',
  'subjectSearch',
  'vector',
  'videoIndex',
])

function channelDomain(channel: string): string {
  if (channel.startsWith('fm-')) return 'fm'
  return channel.split(':', 1)[0]
}

export function getIpcCapabilityDeclaration(channel: string): IpcCapabilityDeclaration | null {
  if (typeof channel !== 'string' || channel.length === 0 || channel.length > 128) return null
  const domain = channelDomain(channel)
  if (!CORE_CHANNELS.has(channel) && domain !== 'fm' && !DOMAIN_PREFIXES.has(domain)) return null

  const capabilities = new Set<IpcCapability>(['R'])
  if (channel === 'terms:accept') capabilities.add('W')
  if (channel === 'terms:get' || channel === 'terms:accept' || channel === 'app:viewEndUserTerms')
    capabilities.add('FS')
  if (WRITE_OPERATION.test(channel)) capabilities.add('W')
  if (
    domain === 'fm' ||
    FILESYSTEM_DOMAINS.has(domain) ||
    channel === 'app:openThirdPartyLicenses' ||
    /(?:folder|settings|config)/i.test(channel)
  ) {
    capabilities.add('FS')
  }
  if (EXTERNAL_OPERATION.test(channel)) capabilities.add('EXT')
  if (PROCESS_DOMAINS.has(domain)) capabilities.add('PROC')
  if (domain === 'remoteTerminal') {
    capabilities.add('NET')
    if (/(?:connect|credential|profile)/i.test(channel)) capabilities.add('SECRET')
  }
  if (channel === 'catalog:remoteDownload/create') capabilities.add('NET')
  if (channel === 'catalog:remoteVideo/prepare') {
    capabilities.add('W')
    capabilities.add('NET')
  }
  if (channel === 'catalog:remotePreview/get') {
    capabilities.add('W')
    capabilities.add('NET')
  }

  return Object.freeze({
    channel,
    capabilities: Object.freeze([...capabilities]),
    validator: 'bounded-structured-clone-v1' as const,
  })
}
