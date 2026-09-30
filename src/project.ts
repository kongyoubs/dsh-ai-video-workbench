/**
 * 工作区与项目目录布局。
 *
 * 每个项目是一个目录，含：
 *   project.json    —— 项目标记（marker）
 *   artifacts/      —— 各阶段的工件 JSON
 *   checkpoints/    —— 阶段检查点
 *   assets/         —— 生成的画面 / 配音 / 配乐
 *   output/         —— 成片与字幕
 */
import { join, relative, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'

export interface ProjectMarker {
  version: string
  id: string
  title: string
  created_at: string
  target_duration_seconds: number
  style: string
  language: string
  voice: string
  target_platform: string
  /** 显式画幅：16:9 / 9:16 / 3:4。平台只能给默认值，不能代替画幅。 */
  aspect_ratio: string
}

export interface ProjectLayout {
  id: string
  dir: string
  assetsDir: string
  outputDir: string
  artifactsDir: string
  checkpointsDir: string
}

export interface ProjectSummary {
  id: string
  title: string
  created_at: string
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

/** 校验项目 / 分镜 / 资产 ID：拒绝空、路径分隔符、点路径与控制字符。 */
export function validateId(id: string, label: string): void {
  if (id.trim() === '') throw new ProjectError(label + ' must not be empty')
  if (/[/\\]/.test(id)) throw new ProjectError(label + ' must not contain path separators: ' + id)
  if (id === '.' || id === '..' || id.includes('..')) {
    throw new ProjectError(label + ' must not contain dot segments: ' + id)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(id)) throw new ProjectError(label + ' must not contain control characters: ' + id)
}

export function projectLayout(root: string, id: string): ProjectLayout {
  validateId(id, 'project id')
  const dir = join(root, id)
  return {
    id,
    dir,
    assetsDir: join(dir, 'assets'),
    outputDir: join(dir, 'output'),
    artifactsDir: join(dir, 'artifacts'),
    checkpointsDir: join(dir, 'checkpoints'),
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function ensureLayout(layout: ProjectLayout): Promise<void> {
  await Promise.all([
    ensureDir(layout.dir),
    ensureDir(layout.assetsDir),
    ensureDir(layout.outputDir),
    ensureDir(layout.artifactsDir),
    ensureDir(layout.checkpointsDir),
  ])
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

export async function readMarker(layout: ProjectLayout): Promise<ProjectMarker | undefined> {
  return readJson<ProjectMarker>(join(layout.dir, 'project.json'))
}

export async function writeMarker(layout: ProjectLayout, marker: ProjectMarker): Promise<void> {
  await writeJsonAtomic(join(layout.dir, 'project.json'), marker)
}

export async function listProjects(root: string): Promise<ProjectSummary[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const summaries: ProjectSummary[] = []
  for (const entry of entries) {
    const marker = await readMarker(projectLayout(root, entry))
    if (marker === undefined) continue
    summaries.push({ id: marker.id, title: marker.title, created_at: marker.created_at })
  }
  summaries.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return summaries
}

/**
 * 把项目内相对路径解析成绝对路径。拒绝绝对路径、UNC、根路径、`..`，
 * 并校验解析结果仍在项目目录内，防止越界。
 */
export function resolveInProject(layout: ProjectLayout, relative: string): string {
  if (relative === '') throw new ProjectError('empty path')
  if (
    relative.startsWith('/')
    || relative.startsWith('\\')
    || relative.startsWith('//')
    || /^[A-Za-z]:/.test(relative)
  ) {
    throw new ProjectError('absolute paths are not allowed: ' + relative)
  }
  const segments = relative.split(/[/\\]/)
  if (segments.includes('..')) {
    throw new ProjectError('".." is not allowed: ' + relative)
  }
  const resolved = resolve(layout.dir, relative)
  if (resolved !== layout.dir && !resolved.startsWith(layout.dir + sep)) {
    throw new ProjectError('path escapes the project: ' + relative)
  }
  return resolved
}

export function toProjectRelative(layout: ProjectLayout, absolute: string): string {
  const rel = relative(layout.dir, absolute)
  return rel.split(sep).join('/')
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s === '' ? 'project' : s
}

export function resolveWorkspaceRoot(configured: string, envHome: string | undefined): string {
  if (configured.trim() !== '') return resolve(configured)
  if (envHome === undefined || envHome === '') return join(process.cwd(), 'data', 'dsh-ai-video-workbench', 'projects')
  return join(envHome, 'data', 'dsh-ai-video-workbench', 'projects')
}
