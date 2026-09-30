/**
 * FFmpeg 合成：按实测时长排时间轴、渲染每段（Ken Burns / 视频循环 + 旁白）、
 * 拼接、混配乐、烧字幕、输出成片与 SRT。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

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

/** 用 ffprobe 实测媒体时长；失败返回 undefined。 */
export function probeDuration(ffprobePath: string, absolutePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', absolutePath])
    let out = ''
    proc.stdout.on('data', (chunk) => { out += String(chunk) })
    proc.on('error', () => resolve(undefined))
    proc.on('close', (code) => {
      if (code !== 0) return resolve(undefined)
      try {
        resolve(parseFloat(JSON.parse(out).format.duration))
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

const PLATFORM_FRAMES: Record<string, { width: number; height: number }> = {
  // 16:9
  youtube: { width: 1920, height: 1080 },
  bilibili: { width: 1920, height: 1080 },
  b站: { width: 1920, height: 1080 },
  // 9:16
  douyin: { width: 1080, height: 1920 },
  抖音: { width: 1080, height: 1920 },
  wechat: { width: 1080, height: 1920 },
  微信: { width: 1080, height: 1920 },
  // 3:4
  xiaohongshu: { width: 1080, height: 1440 },
  小红书: { width: 1080, height: 1440 },
  generic: { width: 1920, height: 1080 },
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export function resolveFrame(platform: string, scale: number, fps: number): { width: number; height: number; fps: number } {
  const base = PLATFORM_FRAMES[platform] ?? PLATFORM_FRAMES.generic!
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
): Promise<string> {
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
    return out
  } catch {
    // 烧录失败（缺 libass / 字体）回退到无字幕版本，SRT 仍作为 sidecar
    return video
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

/* ------------------------------------------------------------------- main */

export async function composeProject(
  deps: ComposeDeps,
  opts: { projectId: string; burnSubtitles?: boolean; signal: AbortSignal },
): Promise<ComposeResult> {
  const cfg = deps.getConfig()
  const { layout, marker } = await deps.machine.requireProject(opts.projectId)
  const script = await deps.machine.readArtifact<Script>(layout, 'script')
  const manifest = await deps.machine.readArtifact<AssetManifest>(layout, 'asset_manifest')
  if (script === undefined) throw new StateViolationError('PREREQUISITE_VIOLATION', 'no script artifact')
  if (manifest === undefined) throw new StateViolationError('PREREQUISITE_VIOLATION', 'no asset_manifest artifact')

  const frame = resolveFrame(marker.target_platform, cfg.video.renderScale, cfg.video.fps)
  const workDir = join(layout.outputDir, '.work')
  await ensureDir(workDir)

  const segments: string[] = []
  const timeline: Array<{ scene_id: string; start: number; duration: number; narration: string }> = []
  let cursor = 0

  for (const [index, section] of script.sections.entries()) {
    const narration = assetOf(manifest, section.id, ['narration', 'audio'])
    const image = assetOf(manifest, section.id, ['image'])
    const video = assetOf(manifest, section.id, ['video'])

    const narrationAbs = narration === undefined ? undefined : join(layout.dir, narration.path)
    const narrationDur = narrationAbs === undefined ? 0 : (await probeDuration(cfg.ffprobePath, narrationAbs)) ?? 0

    const visual = video ?? image
    if (visual === undefined) continue

    const duration = Math.max(3, narrationDur)
    const seg = join(workDir, `seg_${String(index).padStart(3, '0')}.mp4`)
    await renderSegment(cfg, join(layout.dir, visual.path), visual.type === 'video' ? 'video' : 'image', narrationAbs, duration, frame, seg, opts.signal)
    segments.push(seg)
    timeline.push({ scene_id: section.id, start: cursor, duration, narration: section.narration })
    cursor += duration
  }

  if (segments.length === 0) {
    throw new StateViolationError('COVERAGE_INCOMPLETE', 'no renderable sections — every section needs a visual asset')
  }

  const concat = join(workDir, 'concat.mp4')
  await concatSegments(cfg, segments, concat, opts.signal)

  let withMusic = concat
  const music = assetOf(manifest, '', ['music']) ?? manifest.assets.find((asset) => asset.type === 'music')
  if (music !== undefined) {
    const mixed = join(workDir, 'mixed.mp4')
    await mixMusic(cfg, concat, join(layout.dir, music.path), 0.3, mixed, opts.signal)
    withMusic = mixed
  }

  const srt = buildSrt(timeline)
  const srtPath = join(layout.outputDir, 'film.srt')
  await fs.writeFile(srtPath, srt, 'utf8')

  const filmPath = join(layout.outputDir, 'film.mp4')
  let final = withMusic
  if (opts.burnSubtitles === true) {
    final = await burnSubtitles(cfg, withMusic, srtPath, filmPath, opts.signal)
  }
  if (final !== filmPath) {
    await fs.copyFile(final, filmPath)
  }

  const stat = await fs.stat(filmPath).catch(() => undefined)

  const report: RenderReport = {
    version: '1.0',
    outputs: [{
      path: 'output/film.mp4',
      resolution: `${frame.width}x${frame.height}`,
      duration_seconds: Number(cursor.toFixed(3)),
      ...(stat === undefined ? {} : { file_size_bytes: stat.size }),
    }],
    timeline: timeline.map((t) => ({ scene_id: t.scene_id, start: Number(t.start.toFixed(3)), duration: Number(t.duration.toFixed(3)) })),
  }

  return { report }
}
