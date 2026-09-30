/**
 * FFmpeg 合成：按实测时长排时间轴、渲染每段（Ken Burns / 视频循环 + 旁白）、
 * 拼接、混配乐、烧字幕、输出成片与 SRT。
 *
 * 合成前先经 StateMachine.assertReadyForCompose 校验前置审批；
 * 每次合成都用独立 workdir，成功后原子发布到 output/film.mp4，失败/取消不覆盖上一版。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Config } from './config.js'
import type { AssetManifest, AssetRecord, RenderReport, Script } from './schema.js'
import { type ProjectLayout, ensureDir } from './project.js'
import { StateViolationError, type StateMachine } from './state.js'

export interface ComposeDeps {
  machine: StateMachine
  getConfig(): Config
}

export interface ComposeResult {
  report: RenderReport
}

/** 用 ffprobe 实测媒体时长；失败或非有限正值返回 undefined。 */
export function probeDuration(ffprobePath: string, absolutePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', absolutePath])
    let out = ''
    proc.stdout.on('data', (chunk) => { out += String(chunk) })
    proc.on('error', () => resolve(undefined))
    proc.on('close', (code) => {
      if (code !== 0) return resolve(undefined)
      try {
        const duration = parseFloat(JSON.parse(out).format.duration)
        resolve(Number.isFinite(duration) && duration > 0 ? duration : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}

function run(bin: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { signal })
    let err = ''
    proc.stderr.on('data', (chunk) => { err += String(chunk) })
    proc.on('error', (error) => reject(error))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.slice(-2000) || 'exit ' + code))
    })
  })
}

/* ------------------------------------------------------------------ frame */

const ASPECT_FRAMES: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '3:4': { width: 1080, height: 1440 },
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export function resolveFrame(aspectRatio: string, scale: number, fps: number): { width: number; height: number; fps: number } {
  const base = ASPECT_FRAMES[aspectRatio] ?? ASPECT_FRAMES['16:9']!
  const width = even(base.width * scale)
  const height = even(base.height * scale)
  return { width, height, fps }
}

/* -------------------------------------------------------------- segments */

function visualFilter(kind: 'image' | 'video', width: number, height: number, fps: number, frames: number): string {
  if (kind === 'video') {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`
  }
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},`
    + `zoompan=z='min(zoom+0.0008,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},`
    + 'format=yuv420p'
  )
}

async function renderSegment(
  cfg: Config,
  visualPath: string,
  visualKind: 'image' | 'video',
  audioPath: string | undefined,
  duration: number,
  frame: { width: number; height: number; fps: number },
  out: string,
  signal: AbortSignal,
): Promise<void> {
  const frames = Math.max(1, Math.round(duration * frame.fps))
  const vf = visualFilter(visualKind, frame.width, frame.height, frame.fps, frames)

  const args = ['-y']
  if (visualKind === 'image') args.push('-loop', '1')
  else args.push('-stream_loop', '-1')
  args.push('-i', visualPath)
  if (audioPath !== undefined) {
    args.push('-i', audioPath, '-filter_complex', `[0:v]${vf}[v]`, '-map', '[v]', '-map', '1:a')
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-filter_complex', `[0:v]${vf}[v]`, '-map', '[v]', '-map', '1:a')
  }
  args.push(
    '-t', duration.toFixed(3),
    '-c:v', cfg.video.codec, '-preset', cfg.video.preset, '-crf', String(cfg.video.crf),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-pix_fmt', 'yuv420p',
    out,
  )
  await run(cfg.ffmpegPath, args, signal)
}

async function concatSegments(cfg: Config, segments: string[], out: string, signal: AbortSignal): Promise<void> {
  if (segments.length === 1) {
    await fs.copyFile(segments[0]!, out)
    return
  }
  const list = out + '.txt'
  await fs.writeFile(list, segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
  try {
    await run(cfg.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], signal)
  } finally {
    await fs.rm(list, { force: true })
  }
}

async function mixMusic(cfg: Config, video: string, music: string, volume: number, out: string, signal: AbortSignal): Promise<void> {
  await run(cfg.ffmpegPath, [
    '-y', '-i', video, '-i', music,
    '-filter_complex', `[1:a]volume=${volume.toFixed(2)}[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    out,
  ], signal)
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:')
}

async function burnSubtitles(
  cfg: Config,
  video: string,
  srt: string,
  out: string,
  signal: AbortSignal,
): Promise<{ path: string; burned: boolean }> {
  const parts: string[] = []
  if (cfg.subtitleFont !== '') parts.push(`FontName=${cfg.subtitleFont}`)
  parts.push('FontSize=20', 'Alignment=2')
  const style = ":force_style='" + parts.join(',') + "'"
  const vf = `subtitles='${escapeFilterPath(srt)}'${style}`
  try {
    await run(cfg.ffmpegPath, [
      '-y', '-i', video, '-vf', vf,
      '-c:v', cfg.video.codec, '-preset', cfg.video.preset, '-crf', String(cfg.video.crf),
      '-c:a', 'copy', out,
    ], signal)
    return { path: out, burned: true }
  } catch (error) {
    // 取消 / 超时不是可降级错误，要往上抛；只有缺 libass / 字体才降级
    if (signal.aborted) throw error
    return { path: video, burned: false }
  }
}

function fmtTs(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const rest = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`
}

function buildSrt(timeline: Array<{ start: number; duration: number; narration: string }>): string {
  const lines: string[] = []
  let index = 1
  for (const item of timeline) {
    if (item.narration.trim() === '') continue
    lines.push(String(index), `${fmtTs(item.start)} --> ${fmtTs(item.start + item.duration)}`, item.narration.trim(), '')
    index += 1
  }
  return lines.join('\n')
}

function assetOf(manifest: AssetManifest, sceneId: string, types: string[]): AssetRecord | undefined {
  return manifest.assets.find((asset) => asset.scene_id === sceneId && types.includes(asset.type))
}

/* ------------------------------------------------------------------- lock */

/** 同项目一次只跑一个合成；进程内锁（跨进程需文件锁，见审查建议）。 */
const renderLocks = new Map<string, Promise<unknown>>()

/* ------------------------------------------------------------------- main */

export function composeProject(
  deps: ComposeDeps,
  opts: { projectId: string; burnSubtitles?: boolean; signal: AbortSignal },
): Promise<ComposeResult> {
  const previous = renderLocks.get(opts.projectId) ?? Promise.resolve()
  const current = previous.then(() => composeUnlocked(deps, opts), () => composeUnlocked(deps, opts))
  const guard = current.then(() => undefined, () => undefined)
  renderLocks.set(opts.projectId, guard)
  void guard.then(() => {
    if (renderLocks.get(opts.projectId) === guard) renderLocks.delete(opts.projectId)
  })
  return current
}

async function composeUnlocked(
  deps: ComposeDeps,
  opts: { projectId: string; burnSubtitles?: boolean; signal: AbortSignal },
): Promise<ComposeResult> {
  const cfg = deps.getConfig()
  await deps.machine.assertReadyForCompose(opts.projectId)

  // 调用取消 + 配置超时取最先
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(cfg.renderTimeoutMs)])

  const { layout, marker } = await deps.machine.requireProject(opts.projectId)
  const script = await deps.machine.readArtifact<Script>(layout, 'script')
  const manifest = await deps.machine.readArtifact<AssetManifest>(layout, 'asset_manifest')
  if (script === undefined) throw new StateViolationError('PREREQUISITE_VIOLATION', 'no script artifact')
  if (manifest === undefined) throw new StateViolationError('PREREQUISITE_VIOLATION', 'no asset_manifest artifact')

  const frame = resolveFrame(marker.aspect_ratio, cfg.video.renderScale, cfg.video.fps)
  const workDir = join(layout.outputDir, '.work-' + randomUUID().slice(0, 8))
  await ensureDir(workDir)

  const warnings: string[] = []
  const segments: string[] = []
  const timeline: Array<{ scene_id: string; start: number; duration: number; narration: string }> = []
  let cursor = 0

  for (const [index, section] of script.sections.entries()) {
    const narration = assetOf(manifest, section.id, ['narration'])
    const visual = assetOf(manifest, section.id, ['image', 'video'])
    if (narration === undefined) {
      throw new StateViolationError('COVERAGE_INCOMPLETE', "section '" + section.id + "' has no narration asset")
    }
    if (visual === undefined) {
      throw new StateViolationError('COVERAGE_INCOMPLETE', "section '" + section.id + "' has no visual asset (image or video)")
    }

    const narrationAbs = join(layout.dir, narration.path)
    const narrationDur = await probeDuration(cfg.ffprobePath, narrationAbs)
    if (narrationDur === undefined) {
      throw new StateViolationError('ASSET_MISSING', "narration '" + narration.path + "' has no valid positive duration")
    }

    const duration = Math.max(3, narrationDur)
    const seg = join(workDir, `seg_${String(index).padStart(3, '0')}.mp4`)
    await renderSegment(cfg, join(layout.dir, visual.path), visual.type === 'video' ? 'video' : 'image', narrationAbs, duration, frame, seg, signal)
    segments.push(seg)
    timeline.push({ scene_id: section.id, start: cursor, duration, narration: section.narration })
    cursor += duration
  }

  if (segments.length === 0) {
    throw new StateViolationError('COVERAGE_INCOMPLETE', 'no renderable sections')
  }

  const concat = join(workDir, 'concat.mp4')
  await concatSegments(cfg, segments, concat, signal)

  let withMusic = concat
  const music = manifest.assets.find((asset) => asset.type === 'music')
  if (music !== undefined) {
    const mixed = join(workDir, 'mixed.mp4')
    await mixMusic(cfg, concat, join(layout.dir, music.path), 0.3, mixed, signal)
    withMusic = mixed
  }

  // 字幕：烧录与 sidecar 分开控制
  const srtText = buildSrt(timeline)
  let subtitlePath: string | undefined
  let subtitlesBurned = false
  let srtAbs: string | undefined
  if (opts.burnSubtitles === true || cfg.writeSubtitles) {
    srtAbs = cfg.writeSubtitles ? join(layout.outputDir, 'film.srt') : join(workDir, 'burn.srt')
    await fs.writeFile(srtAbs, srtText, 'utf8')
    if (cfg.writeSubtitles) subtitlePath = 'output/film.srt'
  }

  let finalVideo = withMusic
  if (opts.burnSubtitles === true && srtAbs !== undefined) {
    const burned = join(workDir, 'burned.mp4')
    const result = await burnSubtitles(cfg, withMusic, srtAbs, burned, signal)
    finalVideo = result.path
    subtitlesBurned = result.burned
    if (!result.burned) warnings.push('字幕烧录失败，已回退为无字幕成片（SRT 仍作为 sidecar）')
  }

  // 原子发布：成功后 rename 到 output/film.mp4，不覆盖上一版
  const filmPath = join(layout.outputDir, 'film.mp4')
  await fs.rename(finalVideo, filmPath)
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)

  const stat = await fs.stat(filmPath).catch(() => undefined)
  const finalDuration = (await probeDuration(cfg.ffprobePath, filmPath)) ?? cursor

  const report: RenderReport = {
    version: '1.0',
    outputs: [{
      path: 'output/film.mp4',
      resolution: `${frame.width}x${frame.height}`,
      duration_seconds: Number(finalDuration.toFixed(3)),
      ...(stat === undefined ? {} : { file_size_bytes: stat.size }),
    }],
    timeline: timeline.map((t) => ({ scene_id: t.scene_id, start: Number(t.start.toFixed(3)), duration: Number(t.duration.toFixed(3)) })),
    ...(subtitlePath === undefined ? {} : { subtitle_path: subtitlePath }),
    subtitles_burned: subtitlesBurned,
    ...(warnings.length > 0 ? { warnings } : {}),
  }

  return { report }
}
