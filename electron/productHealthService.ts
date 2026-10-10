import type {
  ProductHealthRepairActionId,
  ProductHealthRepairRequest,
  ProductHealthRepairResult,
  ProductHealthReport,
} from '../shared/ipc/product-health'
import { buildProductHealthReport, type ProductHealthReportInput } from './productHealthReport'

const ACTION_IDS = new Set<ProductHealthRepairActionId>([
  'recheck',
  'reconnect-sources',
  'open-source-rescan',
  'open-image-rebuild',
  'open-model-repair',
  'cancel-background',
  'review-derived-reset',
  'repair-data-protection',
])

export interface ProductHealthServiceDependencies {
  readInput: () => ProductHealthReportInput | Promise<ProductHealthReportInput>
  reconnectSources?: () => number | Promise<number>
  cancelBackground?: () => number | Promise<number>
  repairDataProtection?: () => void | Promise<void>
}

export function normalizeProductHealthRepairRequest(
  raw: unknown,
): ProductHealthRepairRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const request = raw as { actionId?: unknown; confirmed?: unknown }
  if (typeof request.actionId !== 'string' || !ACTION_IDS.has(request.actionId as never)) {
    return null
  }
  if (request.confirmed !== undefined && request.confirmed !== true) return null
  return {
    actionId: request.actionId as ProductHealthRepairActionId,
    ...(request.confirmed === true ? { confirmed: true as const } : {}),
  }
}

export class ProductHealthService {
  constructor(private readonly dependencies: ProductHealthServiceDependencies) {}

  async getReport(): Promise<ProductHealthReport> {
    return buildProductHealthReport(await this.dependencies.readInput())
  }

  async runRepair(raw: unknown): Promise<ProductHealthRepairResult> {
    const request = normalizeProductHealthRepairRequest(raw)
    if (!request) return { ok: false, errorCode: 'invalid-action' }
    const report = await this.getReport()
    if (request.actionId === 'recheck') return { ok: true, report }
    const available = report.checks.flatMap((check) => check.actions)
    const action = available.find((candidate) => candidate.id === request.actionId)
    if (!action) return { ok: false, errorCode: 'action-unavailable', report }
    if (action.requiresConfirmation && request.confirmed !== true) {
      return { ok: false, errorCode: 'confirmation-required', report }
    }

    try {
      switch (request.actionId) {
        case 'reconnect-sources': {
          const affected = (await this.dependencies.reconnectSources?.()) ?? 0
          return { ok: true, affected, report: await this.getReport() }
        }
        case 'cancel-background': {
          const affected = (await this.dependencies.cancelBackground?.()) ?? 0
          return { ok: true, affected, report: await this.getReport() }
        }
        case 'repair-data-protection': {
          if (!this.dependencies.repairDataProtection) {
            return { ok: false, errorCode: 'action-unavailable', report }
          }
          await this.dependencies.repairDataProtection()
          return { ok: true, report: await this.getReport() }
        }
        case 'open-source-rescan':
          return { ok: true, route: 'sources', report }
        case 'open-image-rebuild':
        case 'open-model-repair':
          return { ok: true, route: 'image-search', report }
        case 'review-derived-reset':
          return { ok: true, route: 'settings-data-reset', report }
        default:
          return { ok: false, errorCode: 'invalid-action', report }
      }
    } catch {
      return { ok: false, errorCode: 'repair-failed', report: await this.getReport() }
    }
  }
}
