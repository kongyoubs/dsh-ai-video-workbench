/**
 * dsh-ai-video-workbench 宿主入口。
 *
 * 最小可用版：宿主侧只有状态机 + 工具 + 技能，没有网页面板。
 * 生成不在这里做——委托给 dsh-comfyui 的工具，由 Agent 调用。
 * 配置两扇门进同一份值：cordis.yml 里的 workbench 层，以及（后续）设置页。
 */
import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.js'
import { probeDuration } from './compose.js'
import { resolveWorkspaceRoot } from './project.js'
import { buildSkills } from './skills.js'
import { StateMachine } from './state.js'
import { type PluginRuntime, registerWorkbenchTools } from './tools.js'

export const name = 'dsh-ai-video-workbench'
export { Config }

/** 本插件写进 tools 注册表，所以 fiber 要等它。 */
export const inject = ['tools']

interface SkillsService {
  register(skill: unknown): () => void
}

export function apply(ctx: Context, config: Config): void {
  const resolved: Config = { ...config }

  const machine = new StateMachine({
    workspaceRoot: () => resolveWorkspaceRoot(resolved.workspaceRoot, process.env.DSH_HOME),
    probeDuration: (absolutePath: string) => probeDuration(resolved.ffprobePath, absolutePath),
  })

  const runtime: PluginRuntime = {
    getConfig: () => resolved,
    machine,
  }

  ctx.effect(() => {
    const disposers = registerWorkbenchTools(ctx, runtime)
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-ai-video-workbench: tools')

  let skillDisposers: Array<() => void> = []

  function mountSkills(): void {
    for (const dispose of skillDisposers.reverse()) dispose()
    skillDisposers = []
    const skills = ctx.get('skills') as SkillsService | undefined
    if (skills === undefined) return
    skillDisposers = buildSkills(resolved).map((skill) => skills.register(skill))
  }

  ctx.effect(() => {
    mountSkills()
    return () => {
      for (const dispose of skillDisposers.reverse()) dispose()
      skillDisposers = []
    }
  }, 'dsh-ai-video-workbench: skills')
}
