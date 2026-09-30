/**
 * 工件（artifact）的结构与轻量校验。
 *
 * 校验只做结构层面的「能用」检查——字段是否齐全、类型对不对、引用是否一致。
 * 不评价质量；质量红线写进技能，由 Agent 自审 + 用户把关。
 */

export type ArtifactName = 'brief' | 'script' | 'asset_manifest' | 'render_report'

export interface Brief {
  version: string
  title: string
  theme: string
  audience: string
  target_duration_seconds: number
  target_platform: string
  language: string
  style: string
}

export interface ScriptSection {
  /** 稳定段落 id，后续素材用它关联到脚本。 */
  id: string
  narration: string
  visual: {
    description: string
    prompt: string
  }
}

export interface Script {
  version: string
  sections: ScriptSection[]
}

export type AssetType = 'narration' | 'image' | 'video' | 'music'

export interface AssetRecord {
  id: string
  type: AssetType
  /** 属于脚本的哪一段。music 属于整片，scene_id 留空。 */
  scene_id: string
  /** 项目内相对路径。 */
  path: string
  /** 有声音 / 时长的素材，时长由 ffprobe 实测回填。 */
  duration_seconds?: number
}

export interface AssetManifest {
  version: string
  assets: AssetRecord[]
}

export interface RenderOutput {
  path: string
  resolution: string
  duration_seconds: number
  file_size_bytes?: number
}

export interface RenderReport {
  version: string
  outputs: RenderOutput[]
  timeline: Array<{ scene_id: string; start: number; duration: number }>
  /** SRT sidecar 的项目内相对路径（未生成时为 undefined）。 */
  subtitle_path?: string
  /** 字幕是否已烧进画面。 */
  subtitles_burned?: boolean
  /** 非致命降级提示。 */
  warnings?: string[]
}

export interface Issue {
  path: string
  message: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { validateId } from './project.js'

function isStr(value: unknown): value is string {
  return typeof value === 'string'
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function checkRecord(name: ArtifactName, value: unknown): Issue[] {
  if (!isRecord(value)) return [{ path: name, message: 'must be a JSON object' }]
  return []
}

function validateBrief(value: unknown): Issue[] {
  const base = checkRecord('brief', value)
  if (base.length > 0) return base
  const b = value as Record<string, unknown>
  const issues: Issue[] = []
  if (!isStr(b.title) || b.title.trim() === '') issues.push({ path: 'brief.title', message: 'title is required' })
  if (!isStr(b.theme) || b.theme.trim() === '') issues.push({ path: 'brief.theme', message: 'theme is required' })
  if (!isNum(b.target_duration_seconds) || b.target_duration_seconds <= 0 || b.target_duration_seconds > 1800) {
    issues.push({ path: 'brief.target_duration_seconds', message: 'must be a positive number <= 1800' })
  }
  if (!isStr(b.target_platform)) issues.push({ path: 'brief.target_platform', message: 'target_platform is required' })
  return issues
}

function validateScript(value: unknown): Issue[] {
  const base = checkRecord('script', value)
  if (base.length > 0) return base
  const s = value as Record<string, unknown>
  const issues: Issue[] = []
  if (!Array.isArray(s.sections) || s.sections.length === 0) {
    issues.push({ path: 'script.sections', message: 'must be a non-empty array' })
    return issues
  }
  const seen = new Set<string>()
  for (const [index, section] of s.sections.entries()) {
    if (!isRecord(section)) {
      issues.push({ path: `script.sections[${index}]`, message: 'must be an object' })
      continue
    }
    const id = section.id
    if (!isStr(id) || id.trim() === '') {
      issues.push({ path: `script.sections[${index}].id`, message: 'id is required' })
    } else if (seen.has(id)) {
      issues.push({ path: `script.sections[${index}].id`, message: `duplicate id ${JSON.stringify(id)}` })
    } else {
      try {
        validateId(id, 'section id')
        seen.add(id)
      } catch (error) {
        issues.push({ path: `script.sections[${index}].id`, message: (error as Error).message })
      }
    }
    if (!isStr(section.narration) || section.narration.trim() === '') {
      issues.push({ path: `script.sections[${index}].narration`, message: 'narration is required' })
    }
    const visual = section.visual
    if (!isRecord(visual) || !isStr(visual.prompt) || visual.prompt.trim() === '') {
      issues.push({ path: `script.sections[${index}].visual.prompt`, message: 'visual.prompt is required' })
    }
  }
  return issues
}

const ASSET_TYPES: ReadonlySet<string> = new Set(['narration', 'image', 'video', 'music'])

function validateAssetManifest(value: unknown): Issue[] {
  const base = checkRecord('asset_manifest', value)
  if (base.length > 0) return base
  const m = value as Record<string, unknown>
  const issues: Issue[] = []
  if (!Array.isArray(m.assets)) {
    issues.push({ path: 'asset_manifest.assets', message: 'must be an array' })
    return issues
  }
  const seenIds = new Set<string>()
  for (const [index, asset] of m.assets.entries()) {
    if (!isRecord(asset)) {
      issues.push({ path: `asset_manifest.assets[${index}]`, message: 'must be an object' })
      continue
    }
    if (!isStr(asset.id) || asset.id.trim() === '') {
      issues.push({ path: `asset_manifest.assets[${index}].id`, message: 'id is required' })
    } else if (seenIds.has(asset.id)) {
      issues.push({ path: `asset_manifest.assets[${index}].id`, message: `duplicate asset id ${JSON.stringify(asset.id)}` })
    } else {
      seenIds.add(asset.id)
    }
    if (!isStr(asset.type) || !ASSET_TYPES.has(asset.type)) {
      issues.push({ path: `asset_manifest.assets[${index}].type`, message: `type must be one of ${[...ASSET_TYPES].join(' | ')}` })
    }
    if (asset.type !== 'music' && (!isStr(asset.scene_id) || asset.scene_id.trim() === '')) {
      issues.push({ path: `asset_manifest.assets[${index}].scene_id`, message: 'scene_id is required for non-music assets' })
    }
    if (!isStr(asset.path) || asset.path.trim() === '') {
      issues.push({ path: `asset_manifest.assets[${index}].path`, message: 'path is required' })
    }
    if (asset.duration_seconds !== undefined && !isNum(asset.duration_seconds)) {
      issues.push({ path: `asset_manifest.assets[${index}].duration_seconds`, message: 'must be a finite number when present' })
    }
  }
  return issues
}

function validateRenderReport(value: unknown): Issue[] {
  const base = checkRecord('render_report', value)
  if (base.length > 0) return base
  const r = value as Record<string, unknown>
  const issues: Issue[] = []
  if (!Array.isArray(r.outputs) || r.outputs.length === 0) {
    issues.push({ path: 'render_report.outputs', message: 'must be a non-empty array' })
    return issues
  }
  for (const [index, output] of r.outputs.entries()) {
    if (!isRecord(output) || !isStr(output.path) || output.path.trim() === '') {
      issues.push({ path: `render_report.outputs[${index}].path`, message: 'path is required' })
    }
  }
  return issues
}

export function validateArtifact(name: ArtifactName, value: unknown): Issue[] {
  switch (name) {
    case 'brief': return validateBrief(value)
    case 'script': return validateScript(value)
    case 'asset_manifest': return validateAssetManifest(value)
    case 'render_report': return validateRenderReport(value)
    default: return [{ path: name, message: 'unknown artifact' }]
  }
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((issue) => '  - ' + issue.path + ': ' + issue.message).join('\n')
}
