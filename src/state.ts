/**
 * 状态机：整个插件存在的理由。
 *
 * 两条硬规则（写不进就拒绝，而不是警告后照写）：
 *  1. GATE_VIOLATION —— 需要人工审批的阶段，写 completed 必须带 human_approved=true。
 *  2. PREREQUISITE_VIOLATION —— 前面的阶段没完成（或没批准），后面的阶段不能动。
 *
 * 其余检查（schema、素材存在、覆盖、时长回填）都是为了让「记录为 done」等于「事实上 done」。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import {
  type ArtifactName,
  type AssetManifest,
  type AssetRecord,
  type Issue,
  type RenderReport,
  type Script,
  formatIssues,
  validateArtifact,
} from './schema.js'
import {
  type ProjectLayout,
  type ProjectMarker,
  type ProjectSummary,
  ensureDir,
  ensureLayout,
  listProjects,
  pathExists,
  projectLayout,
  readJson,
  readMarker,
  resolveInProject,
  slugify,
  writeJsonAtomic,
  writeMarker,
} from './project.js'

/* ----------------------------------------------------------------- contract */

export const STAGES = ['brief', 'script', 'assets', 'compose'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_ARTIFACT: Record<Stage, ArtifactName> = {
  brief: 'brief',
  script: 'script',
  assets: 'asset_manifest',
  compose: 'render_report',
}

/** 前三段是审批闸：出图出音前先让人看过脚本。 */
export const GATED_STAGES: ReadonlySet<Stage> = new Set<Stage>(['brief', 'script', 'assets'])

export const CHECKPOINT_STATUSES = ['in_progress', 'awaiting_human', 'completed', 'failed'] as const
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number]

export interface Checkpoint {
  version: '1.0'
  project_id: string
  stage: Stage
  status: CheckpointStatus
  timestamp: string
  human_approval_required: boolean
  human_approved: boolean
  artifact_refs: Record<string, string>
  note?: string
}

export type ViolationCode =
  | 'GATE_VIOLATION'
  | 'PREREQUISITE_VIOLATION'
  | 'SCHEMA_INVALID'
  | 'ASSET_MISSING'
  | 'COVERAGE_INCOMPLETE'
  | 'NO_PROJECT'
  | 'BAD_REQUEST'

export class StateViolationError extends Error {
  constructor(readonly code: ViolationCode, message: string) {
    super(message)
    this.name = 'StateViolationError'
  }
}

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage)
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}

export function isStatus(value: unknown): value is CheckpointStatus {
  return typeof value === 'string' && (CHECKPOINT_STATUSES as readonly string[]).includes(value)
}

/* -------------------------------------------------------------- state views */

export interface StageView {
  stage: Stage
  status: CheckpointStatus | 'pending'
  gated: boolean
  human_approved: boolean
  timestamp?: string
  note?: string
}

export interface ProjectStatus {
  project: ProjectMarker
  stages: StageView[]
  next_stage: Stage | null
  awaiting_approval: Stage | null
}

export interface WriteRequest {
  projectId: string
  stage: Stage
  status: CheckpointStatus
  artifacts: Record<string, unknown>
  humanApproved: boolean
  note?: string
}

export interface WriteResult {
  checkpoint: Checkpoint
  invalidated: Stage[]
  notices: string[]
}

export interface StateMachineDeps {
  workspaceRoot(): string
  probeDuration(absolutePath: string): Promise<number | undefined>
}

/* ------------------------------------------------------------------- engine */

export class StateMachine {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: StateMachineDeps) {}

  layout(projectId: string): ProjectLayout {
    return projectLayout(this.deps.workspaceRoot(), projectId)
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return listProjects(this.deps.workspaceRoot())
  }

  private serialize<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const guard = next.then(() => undefined, () => undefined)
    this.locks.set(projectId, guard)
    void guard.then(() => {
      if (this.locks.get(projectId) === guard) this.locks.delete(projectId)
    })
    return next
  }

  /* ------------------------------------------------------------- projects */

  async initProject(input: {
    id?: string
    title: string
    targetDurationSeconds: number
    style?: string
    language?: string
    voice?: string
  }): Promise<{ layout: ProjectLayout; marker: ProjectMarker; existed: boolean }> {
    const id = input.id ?? slugify(input.title)
    const layout = this.layout(id)
    const existing = await readMarker(layout)
    if (existing !== undefined) {
      return { layout, marker: existing, existed: true }
    }
    const marker: ProjectMarker = {
      version: '1.0',
      id,
      title: input.title,
      created_at: new Date().toISOString(),
      target_duration_seconds: input.targetDurationSeconds,
      style: input.style ?? 'default',
      language: input.language ?? 'zh',
      voice: input.voice ?? '',
      target_platform: '',
    }
    await ensureLayout(layout)
    await writeMarker(layout, marker)
    return { layout, marker, existed: false }
  }

  async updateProject(projectId: string, patch: {
    title?: string
    targetDurationSeconds?: number
    style?: string
    language?: string
    voice?: string
    targetPlatform?: string
  }): Promise<ProjectMarker> {
    return this.serialize(projectId, async () => {
      const { layout, marker } = await this.requireProject(projectId)
      const updated: ProjectMarker = {
        ...marker,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.targetDurationSeconds !== undefined ? { target_duration_seconds: patch.targetDurationSeconds } : {}),
        ...(patch.style !== undefined ? { style: patch.style } : {}),
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
        ...(patch.targetPlatform !== undefined ? { target_platform: patch.targetPlatform } : {}),
      }
      await writeMarker(layout, updated)
      return updated
    })
  }

  async removeProject(projectId: string): Promise<{ trashedTo: string }> {
    return this.serialize(projectId, async () => {
      const { layout } = await this.requireProject(projectId)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const trashDir = join(this.deps.workspaceRoot(), '.trash')
      const target = join(trashDir, projectId + '-' + stamp)
      await fs.mkdir(trashDir, { recursive: true })
      await fs.rename(layout.dir, target)
      return { trashedTo: target }
    })
  }

  async requireProject(projectId: string): Promise<{ layout: ProjectLayout; marker: ProjectMarker }> {
    const layout = this.layout(projectId)
    const marker = await readMarker(layout)
    if (marker === undefined) {
      throw new StateViolationError(
        'NO_PROJECT',
        'no project ' + JSON.stringify(projectId) + " under " + this.deps.workspaceRoot()
        + " — run workbench_project with action 'init' first",
      )
    }
    return { layout, marker }
  }

  /* ---------------------------------------------------------- checkpoints */

  private checkpointPath(layout: ProjectLayout, stage: Stage): string {
    return join(layout.checkpointsDir, stage + '.json')
  }

  async readCheckpoint(layout: ProjectLayout, stage: Stage): Promise<Checkpoint | undefined> {
    return readJson<Checkpoint>(this.checkpointPath(layout, stage))
  }

  async readArtifact<T>(layout: ProjectLayout, name: ArtifactName): Promise<T | undefined> {
    return readJson<T>(join(layout.artifactsDir, name + '.json'))
  }

  async status(projectId: string): Promise<ProjectStatus> {
    const { layout, marker } = await this.requireProject(projectId)
    const stages: StageView[] = []
    let nextStage: Stage | null = null
    let awaiting: Stage | null = null

    for (const stage of STAGES) {
      const checkpoint = await this.readCheckpoint(layout, stage)
      const gated = GATED_STAGES.has(stage)
      if (checkpoint === undefined) {
        stages.push({ stage, status: 'pending', gated, human_approved: false })
        if (nextStage === null) nextStage = stage
        continue
      }
      const view: StageView = {
        stage,
        status: checkpoint.status,
        gated,
        human_approved: checkpoint.human_approved,
        timestamp: checkpoint.timestamp,
      }
      if (checkpoint.note !== undefined) view.note = checkpoint.note
      stages.push(view)

      if (checkpoint.status === 'awaiting_human' && awaiting === null) awaiting = stage
      if (checkpoint.status !== 'completed' && nextStage === null) nextStage = stage
    }

    return { project: marker, stages, next_stage: nextStage, awaiting_approval: awaiting }
  }

  /* ----------------------------------------------------------------- write */

  async write(request: WriteRequest): Promise<WriteResult> {
    return this.serialize(request.projectId, () => this.writeUnlocked(request))
  }

  private async writeUnlocked(request: WriteRequest): Promise<WriteResult> {
    const { stage, status } = request
    const { layout } = await this.requireProject(request.projectId)
    const notices: string[] = []

    const canonical = STAGE_ARTIFACT[stage]
    const needsArtifact = status === 'completed' || status === 'awaiting_human'
    if (needsArtifact && request.artifacts[canonical] === undefined) {
      throw new StateViolationError(
        'BAD_REQUEST',
        "stage '" + stage + "' with status '" + status + "' must supply its artifact '" + canonical + "'",
      )
    }

    // 1. 结构校验
    const issues: Issue[] = []
    for (const [name, value] of Object.entries(request.artifacts)) {
      if (!Object.values(STAGE_ARTIFACT).includes(name as ArtifactName)) {
        issues.push({ path: name, message: 'unknown artifact' })
        continue
      }
      issues.push(...validateArtifact(name as ArtifactName, value))
    }
    if (issues.length > 0) {
      throw new StateViolationError(
        'SCHEMA_INVALID',
        'SCHEMA INVALID: ' + issues.length + " problem(s) in stage '" + stage + "' artifacts:\n" + formatIssues(issues),
      )
    }

    // 2. 事实校验 + 时长回填（回填产生新对象，不写穿调用方深冻结的参数）
    const persisted: Record<string, unknown> = { ...request.artifacts }
    if (request.artifacts[canonical] !== undefined) {
      if (stage === 'assets') {
        const verified = await this.verifyAssets(layout, request.artifacts[canonical] as AssetManifest, needsArtifact)
        notices.push(...verified.notices)
        persisted[canonical] = verified.manifest
      }
      if (stage === 'compose') {
        await this.verifyRender(layout, request.artifacts[canonical] as RenderReport)
      }
    }

    // 3. 闸门，再顺序
    const gated = GATED_STAGES.has(stage)
    if (gated && status === 'completed' && !request.humanApproved) {
      throw new StateViolationError(
        'GATE_VIOLATION',
        "GATE VIOLATION: stage '" + stage + "' is an approval gate but was written completed without human_approved=true.\n"
        + "Correct protocol: write status='awaiting_human', show the user a summary, END YOUR TURN, "
        + "and only after the user approves, re-write with status='completed' and human_approved=true.",
      )
    }

    if (status !== 'failed') {
      await this.enforcePrerequisites(layout, stage)
    }

    // 4. 重写前序阶段会让后面全部作废
    const invalidated = needsArtifact ? await this.invalidateSuccessors(layout, stage) : []
    if (invalidated.length > 0) {
      notices.push('discarded later stage(s) ' + invalidated.join(', ') + ' because ' + stage + ' was rewritten; they must be redone')
    }

    // 5. 先落工件，再落指向它的检查点
    const artifactRefs: Record<string, string> = {}
    for (const [name, value] of Object.entries(persisted)) {
      const relative = 'artifacts/' + name + '.json'
      await ensureDir(layout.artifactsDir)
      await writeJsonAtomic(join(layout.dir, 'artifacts', name + '.json'), value)
      artifactRefs[name] = relative
    }

    await ensureDir(layout.checkpointsDir)
    const checkpoint: Checkpoint = {
      version: '1.0',
      project_id: request.projectId,
      stage,
      status,
      timestamp: new Date().toISOString(),
      human_approval_required: gated,
      human_approved: gated ? request.humanApproved : false,
      artifact_refs: artifactRefs,
      ...(request.note !== undefined ? { note: request.note } : {}),
    }
    await writeJsonAtomic(this.checkpointPath(layout, stage), checkpoint)

    return { checkpoint, invalidated, notices }
  }

  /* -------------------------------------------------------------- the rules */

  private async enforcePrerequisites(layout: ProjectLayout, stage: Stage): Promise<void> {
    const index = stageIndex(stage)
    const incomplete: string[] = []
    const unapproved: string[] = []

    for (const predecessor of STAGES.slice(0, index)) {
      const checkpoint = await this.readCheckpoint(layout, predecessor)
      if (checkpoint === undefined || checkpoint.status !== 'completed') {
        incomplete.push(predecessor + (checkpoint === undefined ? ' (never started)' : ' (' + checkpoint.status + ')'))
        continue
      }
      if (GATED_STAGES.has(predecessor) && !checkpoint.human_approved) {
        unapproved.push(predecessor)
      }
    }

    if (incomplete.length === 0 && unapproved.length === 0) return

    const details: string[] = []
    if (incomplete.length > 0) details.push('incomplete or missing: ' + incomplete.join(', '))
    if (unapproved.length > 0) details.push('completed without required approval: ' + unapproved.join(', '))
    throw new StateViolationError(
      'PREREQUISITE_VIOLATION',
      "PREREQUISITE VIOLATION: stage '" + stage + "' cannot be written; " + details.join('; ')
      + '. Pipeline order: ' + STAGES.join(' -> ') + '.',
    )
  }

  /**
   * 素材必须存在、属于脚本里的某一段、有时长的用 ffprobe 实测回填。
   * 只有 completed 才要求覆盖完整（每段都有旁白 + 画面）。
   */
  private async verifyAssets(
    layout: ProjectLayout,
    manifest: AssetManifest,
    requireCoverage: boolean,
  ): Promise<{ manifest: AssetManifest; notices: string[] }> {
    const script = await this.readArtifact<Script>(layout, 'script')
    if (script === undefined) {
      throw new StateViolationError('PREREQUISITE_VIOLATION', 'cannot verify assets: no script artifact on disk')
    }
    const sectionIds = new Set(script.sections.map((section) => section.id))
    const notices: string[] = []
    const missing: string[] = []
    const orphaned: string[] = []
    const measured: AssetRecord[] = []

    for (const asset of manifest.assets) {
      let absolute: string
      try {
        absolute = resolveInProject(layout, asset.path)
      } catch (error) {
        missing.push(asset.id + ' -> ' + asset.path + ' (' + (error as Error).message + ')')
        continue
      }
      if (!(await pathExists(absolute))) {
        missing.push(asset.id + ' -> ' + asset.path)
        continue
      }
      if (asset.type !== 'music' && !sectionIds.has(asset.scene_id)) {
        orphaned.push(asset.id + " -> scene_id '" + asset.scene_id + "'")
        continue
      }
      const hasTimeline = asset.type === 'narration' || asset.type === 'music' || asset.type === 'video'
      if (!hasTimeline) {
        measured.push(asset)
        continue
      }
      const duration = await this.deps.probeDuration(absolute)
      if (duration === undefined) {
        missing.push(asset.id + ' -> ' + asset.path + ' (exists but ffprobe could not read a duration)')
        continue
      }
      if (asset.duration_seconds !== undefined && Math.abs(asset.duration_seconds - duration) > 0.05) {
        notices.push(asset.id + ': declared ' + asset.duration_seconds.toFixed(2) + 's, measured ' + duration.toFixed(2) + 's — using the measurement')
      }
      measured.push({ ...asset, duration_seconds: Number(duration.toFixed(3)) })
    }

    if (missing.length > 0) {
      throw new StateViolationError(
        'ASSET_MISSING',
        'ASSET MISSING: ' + missing.length + ' asset(s) not readable under ' + layout.dir + ':\n'
        + missing.map((line) => '  - ' + line).join('\n'),
      )
    }
    if (orphaned.length > 0) {
      throw new StateViolationError(
        'COVERAGE_INCOMPLETE',
        'ASSET ORPHANED: ' + orphaned.length + ' asset(s) reference a scene_id not in the script:\n'
        + orphaned.map((line) => '  - ' + line).join('\n'),
      )
    }

    const normalised: AssetManifest = { ...manifest, assets: measured }
    if (!requireCoverage) return { manifest: normalised, notices }

    const gaps: string[] = []
    for (const section of script.sections) {
      const mine = manifest.assets.filter((asset) => asset.scene_id === section.id)
      if (!mine.some((asset) => asset.type === 'narration')) {
        gaps.push(section.id + ': no narration asset')
      }
      if (!mine.some((asset) => asset.type === 'image' || asset.type === 'video')) {
        gaps.push(section.id + ': no visual asset (image or video)')
      }
    }
    if (gaps.length > 0) {
      throw new StateViolationError(
        'COVERAGE_INCOMPLETE',
        'COVERAGE INCOMPLETE: every script section needs narration and a visual:\n'
        + gaps.map((line) => '  - ' + line).join('\n'),
      )
    }

    return { manifest: normalised, notices }
  }

  private async verifyRender(layout: ProjectLayout, report: RenderReport): Promise<void> {
    const missing: string[] = []
    for (const output of report.outputs) {
      try {
        const absolute = resolveInProject(layout, output.path)
        if (!(await pathExists(absolute))) missing.push(output.path)
      } catch (error) {
        missing.push(output.path + ' (' + (error as Error).message + ')')
      }
    }
    if (missing.length > 0) {
      throw new StateViolationError(
        'ASSET_MISSING',
        'ASSET MISSING: render report names output file(s) that do not exist:\n'
        + missing.map((line) => '  - ' + line).join('\n'),
      )
    }
  }

  /** 重写某阶段后，归档并移除其后的所有阶段。 */
  private async invalidateSuccessors(layout: ProjectLayout, stage: Stage): Promise<Stage[]> {
    const invalidated: Stage[] = []
    for (const successor of STAGES.slice(stageIndex(stage) + 1)) {
      const checkpoint = await this.readCheckpoint(layout, successor).catch(() => undefined)
      if (checkpoint === undefined) continue
      await fs.rm(this.checkpointPath(layout, successor), { force: true })
      invalidated.push(successor)
    }
    return invalidated
  }
}
