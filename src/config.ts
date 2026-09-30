/**
 * dsh-ai-video-workbench 宿主配置。
 *
 * 两个不同生命周期的配置组：
 * - 渲染参数（video、ffmpegPath）描述这台机器，很少变。
 * - bindings 描述每项生成能力当前由 dsh-comfyui 工作流库里的哪条工作流承担。
 *   插件自己不调 ComfyUI——它把 bindings 交给 Agent，让 Agent 去调
 *   `comfyui_workflow`。换一条 TTS / 文生图工作流因此是一次配置改动，而不是改代码。
 */
import z from '@deepseek-ai/schemastery'

/** 每项生成能力由哪条 ComfyUI 工作流承担。 */
export interface CapabilityBinding {
  /** 候选工作流名，第一条是默认。填名称不填 id（id 每次重新解析 ComfyUI 工作流都会变）。 */
  workflows: string[]
  /** 给 Agent 的额外提示，原样出现在技能里。 */
  notes: string
}

export interface VideoProfile {
  /** 生成倍率：16:9 基线 1920x1080，9:16 基线 1080x1920，乘此系数得到实际尺寸。 */
  renderScale: number
  fps: number
  codec: string
  crf: number
  preset: string
}

export interface Config {
  /** 项目根目录。空 = $DSH_HOME/data/dsh-ai-video-workbench/projects。 */
  workspaceRoot: string
  ffmpegPath: string
  ffprobePath: string
  /** 用户没说时长时用的默认成片时长（秒）。 */
  defaultDurationSeconds: number
  language: 'zh' | 'en'
  video: VideoProfile
  /** 输出 .srt 字幕 sidecar。 */
  writeSubtitles: boolean
  /** 烧录字幕字体名，留空用系统默认。 */
  subtitleFont: string
  bindings: {
    tts: CapabilityBinding
    image: CapabilityBinding
    music: CapabilityBinding
  }
  /** 单次合成超时上限（毫秒）。 */
  renderTimeoutMs: number
}

const binding = () => z.object({
  workflows: z.array(z.string()).default([])
    .description('dsh-comfyui 工作流库里的名称，第一条为默认。填名称不填 id。'),
  notes: z.string().default('')
    .description('给 Agent 的额外提示，会原样写进技能。参数细节不用写，去 comfyui_workflow 的清单里查。'),
})

export const Config: z<Config> = z.object({
  workspaceRoot: z.string().default('')
    .description('项目根目录。留空 = $DSH_HOME/data/dsh-ai-video-workbench/projects。成片、素材、状态都落在这里。'),
  ffmpegPath: z.string().default('ffmpeg')
    .description('ffmpeg 可执行文件，在 PATH 上就填 ffmpeg。'),
  ffprobePath: z.string().default('ffprobe')
    .description('ffprobe 可执行文件，用于实测配音时长。'),
  defaultDurationSeconds: z.number().min(5).max(1800).default(30)
    .description('默认成片时长（秒）。'),
  language: z.union([z.const('zh'), z.const('en')]).default('zh')
    .description('脚本与配音的默认语种。'),
  video: z.object({
    renderScale: z.number().min(0.1).max(2).default(1)
      .description('生成倍率。1 = 原尺寸（16:9 出 1920x1080），0.5 = 一半。'),
    fps: z.number().min(12).max(60).default(30).description('帧率'),
    codec: z.string().default('libx264').description('视频编码器'),
    crf: z.number().min(0).max(51).default(20).description('画质，越小越清晰'),
    preset: z.string().default('medium').description('编码速度档'),
  }).description('编码参数。'),
  writeSubtitles: z.boolean().default(true)
    .description('输出 .srt 字幕文件（与成片同目录）。'),
  subtitleFont: z.string().default('')
    .description('烧录字幕的字体名，留空用系统默认。'),
  bindings: z.object({
    tts: binding().description('配音（TTS）'),
    image: binding().description('配图（文生图）'),
    music: binding().description('配乐（可选，文生音乐）'),
  }).description('每项生成能力用哪条 dsh-comfyui 工作流。只填名称。'),
  renderTimeoutMs: z.number().min(10_000).max(3_600_000).default(900_000)
    .description('单次合成超时上限（毫秒），默认 15 分钟。'),
}) as unknown as z<Config>
