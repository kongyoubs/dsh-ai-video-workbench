/**
 * 三个面向 Agent 的工具。
 *
 * `workbench_stage` 是唯一能推进状态机的入口。`workbench_project` 和
 * `workbench_compose` 都不能推进状态：compose 只是渲染并返回报告，
 * 报告要经 `workbench_stage` 的检查才被记录。单一写入口是治理成立的前提。
 */
import { extname, join } from 'node:path'
import { createWriteStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { type Config, type CapabilityBinding } from './config.js'
import { type ArtifactName, type RenderReport, type Script } from './schema.js'
import { type ProjectLayout, ensureDir, pathExists, resolveInProject } from './project.js'
import { composeProject } from './compose.js'
import { mediaKindOf, mediaUrl } from './routes.js'
import {
  type Stage,
  STAGES,
  STAGE_ARTIFACT,
  GATED_STAGES,
  StateMachine,
  StateViolationError,
  isStage,
  isStatus,
} from './state.js'

/** 结构化的 ToolDefinition，与宿主工具包解耦。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): unknown[]
    /** 结构化负载，供工具调用的 media 卡片渲染。文本是转录保留的，卡片画的是这个。 */
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  timeoutMs?: number
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
}

export interface ToolRunContext {
  signal: AbortSignal
}

export interface PluginRuntime {
  getConfig(): Config
  readonly machine: StateMachine
}

export function text(body: string): unknown[] {
  return [{ type: 'text', text: body }]
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StateViolationError('BAD_REQUEST', key + ' is required and must be a non-empty string')
  }
  return value.trim()
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new StateViolationError('BAD_REQUEST', key + ' must be a string')
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StateViolationError('BAD_REQUEST', key + ' must be a JSON object')
  }
  return value as Record<string, unknown>
}

function pathsOf(layout: ProjectLayout): Record<string, string> {
  return {
    project: layout.dir,
    assets: layout.assetsDir,
    output: layout.outputDir,
  }
}

function renderBindings(bindings: Config['bindings']): string {
  const lines = ['生成能力绑定 —— 逐条去 `comfyui_workflow action: list` 查参数：']
  for (const [capability, binding] of Object.entries(bindings) as Array<[string, CapabilityBinding]>) {
    const all = binding.workflows.filter((name) => name.trim() !== '')
    if (all.length === 0) {
      lines.push('  ' + capability + ': 未绑定 —— 请用户先在设置里填一条 dsh-comfyui 工作流名，不要自己猜')
      continue
    }
    lines.push('  ' + capability + ': "' + all[0] + '"')
    if (binding.notes.trim() !== '') lines.push('    备注: ' + binding.notes.trim())
  }
  return lines.join('\n')
}

/* ------------------------------------------------------ workbench_project */

const IMPORT_KINDS = ['narration', 'image', 'video', 'music'] as const

function projectDefinition(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'workbench_project',
    description:
      '管理 AI 视频创作工作台的项目与工作文件。'
      + "`init` 创建项目并返回可写素材的绝对路径。"
      + "`status` 报告每个阶段的进度、下一个阶段、是否停在审批闸——操作前先调它。"
      + "`list` 列出项目。`get` 读回一个工件（brief/script/asset_manifest/render_report）。"
      + "`import` 把生成好的文件（本地绝对路径，或 dsh-comfyui 媒体代理的 http(s) 链接）复制进项目，返回要在素材清单里填的项目内相对路径。"
      + "`bindings` 显示当前 TTS / 文生图 / 配乐用哪条 dsh-comfyui 工作流。"
      + '本工具从不推进状态机，只有 workbench_stage 能。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'list', 'status', 'get', 'import', 'bindings'] },
        project: { type: 'string', description: '项目 id。status/get/import 需要。' },
        title: { type: 'string', description: 'init: 项目标题。' },
        id: { type: 'string', description: 'init: 显式项目 id（小写字母、数字、-、_）。省略则从标题生成。' },
        target_duration_seconds: { type: 'number', description: 'init: 成片目标时长。' },
        style: { type: 'string', description: 'init: 视觉风格。' },
        voice: { type: 'string', description: 'init: 配音音色，按 TTS 工作流的参数选项精确命名。' },
        language: { type: 'string', description: 'init: 语种（zh/en），省略用配置默认。' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '3:4'], description: 'init: 画幅，默认 16:9。' },
        artifact: { type: 'string', enum: ['brief', 'script', 'asset_manifest', 'render_report'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: '本地绝对路径或 http(s) URL。' },
              kind: { type: 'string', enum: [...IMPORT_KINDS] },
              scene_id: { type: 'string', description: "所属脚本段落 id；kind 为 music 时省略。" },
            },
            required: ['source', 'kind'],
          },
        },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value, null, 2)) },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const action = requireString(args, 'action')
      const machine = runtime.machine
      const config = runtime.getConfig()

      if (action === 'list') {
        return { action, projects: await machine.listProjects() }
      }

      if (action === 'bindings') {
        return { action, bindings: config.bindings, hint: renderBindings(config.bindings) }
      }

      if (action === 'init') {
        const title = requireString(args, 'title')
        const duration = typeof args.target_duration_seconds === 'number'
          ? args.target_duration_seconds
          : config.defaultDurationSeconds
        const created = await machine.initProject({
          title,
          targetDurationSeconds: duration,
          ...(optionalString(args, 'id') !== undefined ? { id: optionalString(args, 'id')! } : {}),
          ...(optionalString(args, 'style') !== undefined ? { style: optionalString(args, 'style')! } : {}),
          ...(optionalString(args, 'voice') !== undefined ? { voice: optionalString(args, 'voice')! } : {}),
          language: optionalString(args, 'language') ?? config.language,
          aspectRatio: optionalString(args, 'aspect_ratio') ?? '16:9',
        })
        return {
          action,
          project: created.marker,
          existed: created.existed,
          paths: pathsOf(created.layout),
          next_stage: 'brief',
          bindings: config.bindings,
        }
      }

      const projectId = requireString(args, 'project')

      if (action === 'status') {
        const status = await machine.status(projectId)
        return { action, ...status, paths: pathsOf(machine.layout(projectId)) }
      }

      if (action === 'get') {
        const artifact = requireString(args, 'artifact') as ArtifactName
        const { layout } = await machine.requireProject(projectId)
        const value = await machine.readArtifact<unknown>(layout, artifact)
        if (value === undefined) {
          throw new StateViolationError('BAD_REQUEST', 'project ' + projectId + ' has no ' + artifact + ' yet')
        }
        return { action, artifact, value }
      }

      if (action === 'import') {
        const items = args.items
        if (!Array.isArray(items) || items.length === 0) {
          throw new StateViolationError('BAD_REQUEST', 'import needs a non-empty items array')
        }
        // 导入素材要求 brief + script 已完成且批准（见 assertReadyForAssets）
        await machine.assertReadyForAssets(projectId)
        const { layout } = await machine.requireProject(projectId)
        const script = await machine.readArtifact<Script>(layout, 'script')
        const sceneIds = new Set((script?.sections ?? []).map((section) => section.id))

        const imported: Array<{ kind: string; scene_id: string; path: string; bytes: number }> = []
        for (const [index, item] of items.entries()) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new StateViolationError('BAD_REQUEST', 'items[' + index + '] must be an object')
          }
          const record = item as Record<string, unknown>
          const kind = requireString(record, 'kind')
          if (!(IMPORT_KINDS as readonly string[]).includes(kind)) {
            throw new StateViolationError('BAD_REQUEST', 'items[' + index + '].kind must be one of ' + IMPORT_KINDS.join(' | '))
          }
          const source = requireString(record, 'source')
          const sceneId = kind === 'music' ? '' : requireString(record, 'scene_id')
          if (sceneId !== '' && !sceneIds.has(sceneId)) {
            throw new StateViolationError('BAD_REQUEST', "scene_id '" + sceneId + "' is not in the script")
          }

          const bytes = await copySource(source, layout.assetsDir, kind, exec.signal)
          const rel = 'assets/' + bytes.filename
          imported.push({ kind, scene_id: sceneId, path: rel, bytes: bytes.size })
        }
        return { action, imported, paths: pathsOf(layout) }
      }

      throw new StateViolationError('BAD_REQUEST', 'unknown action ' + JSON.stringify(action))
    },
  }
}

/** 单条导入的大小上限。 */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024

/** 把本地路径或 http(s) URL 流式复制进素材目录，返回文件名与大小。文件名只用 UUID，scene_id 存元数据。 */
async function copySource(source: string, assetsDir: string, kind: string, signal: AbortSignal): Promise<{ filename: string; size: number }> {
  const ext = /^https?:\/\//.test(source) ? extname(new URL(source).pathname) : extname(source)
  const filename = `${kind}-${randomUUID().slice(0, 8)}${ext}`
  const dest = join(assetsDir, filename)
  await ensureDir(assetsDir)

  if (/^https?:\/\//.test(source)) {
    const resp = await fetch(source, { signal })
    if (!resp.ok || resp.body === null) {
      throw new StateViolationError('BAD_REQUEST', 'download failed ' + resp.status + ' ' + source)
    }
    await pipeline(Readable.fromWeb(resp.body as ReadableStream), createWriteStream(dest), { signal })
  } else {
    if (!(await pathExists(source))) {
      throw new StateViolationError('BAD_REQUEST', 'no such file: ' + source)
    }
    await fs.copyFile(source, dest)
  }

  const stat = await fs.stat(dest)
  if (stat.size > MAX_IMPORT_BYTES) {
    await fs.rm(dest, { force: true })
    throw new StateViolationError('BAD_REQUEST', 'imported file too large: ' + stat.size + ' bytes')
  }
  return { filename, size: stat.size }
}

/* ------------------------------------------------------- workbench_stage */

function stageDefinition(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'workbench_stage',
    description:
      '记录一个阶段并推进项目。这是推进状态的唯一入口，每次写入都被检查：'
      + '工件必须过 schema、前面的阶段必须完成（需要审批的还要批准）、素材路径必须存在、'
      + '审批闸阶段写成 completed 必须带 human_approved=true。检查失败是抛错，不是警告后照写。'
      + "审批协议：brief 和 script 先写 status='awaiting_human' 并附工件，用中文向用户概述，END YOUR TURN；"
      + "等用户真正批准后，再写 status='completed' 且 human_approved=true。"
      + '重写更早的阶段会作废其后的所有阶段。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        stage: { type: 'string', enum: [...STAGES] },
        status: { type: 'string', enum: ['in_progress', 'awaiting_human', 'completed', 'failed'] },
        artifacts: { type: 'object', description: '工件名 -> 值。如 {"script": {...}}' },
        human_approved: { type: 'boolean', description: '仅当用户真的在对话里批准了才为 true' },
        note: { type: 'string' },
      },
      required: ['project', 'stage', 'status'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const data = value as Record<string, unknown>
        const lines = [`Stage "${data.stage}" recorded as ${data.status}.`]
        if (data.gated) lines.push(data.human_approved ? 'Gate satisfied: user approved.' : 'This stage is an approval gate.')
        const invalidated = data.invalidated as string[]
        if (invalidated.length > 0) lines.push('Discarded later stage(s): ' + invalidated.join(', '))
        if (data.status === 'awaiting_human') {
          lines.push('', 'STOP HERE. 用中文向用户概述工件内容，然后结束本轮。')
        } else if (data.next_stage === null) {
          lines.push('', 'Pipeline complete.')
        } else {
          lines.push('', 'Next stage: ' + data.next_stage)
        }
        return text(lines.join('\n'))
      },
    },
    timeoutMs: 120_000,
    async execute(args, _exec) {
      const projectId = requireString(args, 'project')
      const stageRaw = requireString(args, 'stage')
      const statusRaw = requireString(args, 'status')
      if (!isStage(stageRaw)) throw new StateViolationError('BAD_REQUEST', 'stage must be one of ' + STAGES.join(', '))
      if (!isStatus(statusRaw)) throw new StateViolationError('BAD_REQUEST', 'status must be in_progress | awaiting_human | completed | failed')

      const artifacts = optionalRecord(args, 'artifacts') ?? {}
      const humanApproved = args.human_approved === true

      const result = await runtime.machine.write({
        projectId,
        stage: stageRaw as Stage,
        status: statusRaw,
        artifacts,
        humanApproved,
        ...(optionalString(args, 'note') !== undefined ? { note: optionalString(args, 'note')! } : {}),
      })

      const status = await runtime.machine.status(projectId)
      return {
        stage: stageRaw,
        status: statusRaw,
        gated: GATED_STAGES.has(stageRaw as Stage),
        human_approved: result.checkpoint.human_approved,
        invalidated: result.invalidated,
        notices: result.notices,
        next_stage: status.next_stage,
        awaiting_approval: status.awaiting_approval,
      }
    },
  }
}

/* ------------------------------------------------------ workbench_compose */

function composeDefinition(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'workbench_compose',
    description:
      '用 FFmpeg 把已批准的脚本和已记录的素材清单渲染成片：先实测每段配音时长，按实测排时间轴，'
      + '写 SRT，输出成片。它不推进状态——把返回的 render_report 原样传给 workbench_stage '
      + 'stage="compose" status="completed" 来记录。要求 assets 阶段已完成。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        burn_subtitles: { type: 'boolean', description: '是否把字幕烧进画面。烧录会重编码。' },
      },
      required: ['project'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const data = value as { report: RenderReport }
        const output = data.report.outputs[0]
        const lines: string[] = []
        if (output !== undefined) {
          lines.push('Rendered ' + output.path + '  ' + output.resolution + '  ' + output.duration_seconds.toFixed(1) + 's')
        }
        lines.push('', 'Now record it: workbench_stage stage="compose" status="completed", passing the render_report object through UNCHANGED.')
        return text(lines.join('\n'))
      },
    },
    timeoutMs: 3_600_000,
    async execute(args, exec) {
      const result = await composeProject(runtime, {
        projectId: requireString(args, 'project'),
        ...(args.burn_subtitles === true ? { burnSubtitles: true } : {}),
        signal: exec.signal,
      })
      return result
    },
  }
}

/* ------------------------------------------------------ workbench_show */

function showDefinition(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'workbench_show',
    description:
      '把项目里的媒体放进对话给用户看：成片、配音、画面，任何已在项目里的文件。'
      + '路径是项目内相对路径（如 output/film.mp4、assets/s1-image-xxxx.png）。'
      + '它只展示已存在的文件——不生成、不导入、不记录任何东西。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        note: { type: 'string', description: '可选，一行说明显示在媒体上方。' },
      },
      required: ['project', 'paths'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const data = value as { note?: string; items: Array<{ name: string; kind: string; bytes: number }> }
        const lines = data.note === undefined ? [] : [data.note]
        for (const item of data.items) {
          lines.push('  ' + item.name + '  ' + item.kind + '  ' + Math.round(item.bytes / 1024) + ' KB')
        }
        return text(lines.join('\n'))
      },
      presentationMeta: (_args, value) => {
        const data = value as { project: string; items: unknown[]; note?: string }
        return {
          kind: 'media',
          project: data.project,
          items: data.items,
          ...(data.note === undefined ? {} : { note: data.note }),
        }
      },
    },
    timeoutMs: 30_000,
    async execute(args, _exec) {
      const projectId = requireString(args, 'project')
      const paths = args.paths
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new StateViolationError('BAD_REQUEST', 'paths must be a non-empty array')
      }
      const { layout } = await runtime.machine.requireProject(projectId)
      const items: Array<{ path: string; name: string; kind: string; bytes: number; url: string }> = []
      for (const entry of paths) {
        if (typeof entry !== 'string' || entry.trim() === '') continue
        const relative = entry.trim()
        const absolute = resolveInProject(layout, relative)
        if (!(await pathExists(absolute))) {
          throw new StateViolationError('BAD_REQUEST', 'no such file in the project: ' + relative)
        }
        const stat = await fs.stat(absolute)
        items.push({
          path: relative,
          name: relative.split('/').pop() ?? relative,
          kind: mediaKindOf(relative),
          bytes: stat.size,
          url: mediaUrl(projectId, relative),
        })
      }
      if (items.length === 0) {
        throw new StateViolationError('BAD_REQUEST', 'none of the given paths named a file')
      }
      return {
        project: projectId,
        items,
        ...(optionalString(args, 'note') === undefined ? {} : { note: optionalString(args, 'note') }),
      }
    },
  }
}

/* ------------------------------------------------------------- registry */

export function registerWorkbenchTools(ctx: unknown, runtime: PluginRuntime): Array<() => void> {
  const tools = (ctx as { tools: { register(definition: ToolDefinition): () => void } }).tools
  return [
    tools.register(projectDefinition(runtime)),
    tools.register(stageDefinition(runtime)),
    tools.register(composeDefinition(runtime)),
    tools.register(showDefinition(runtime)),
  ]
}
