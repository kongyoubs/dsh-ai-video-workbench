/**
 * 运行时技能：给 Agent 的作业指导。
 *
 * 一份「管线地图」+ 一份「工具契约」。地图讲全局（顺序、闸、红线、绑定），
 * 契约讲工具怎么用、报错怎么处置。
 */
import type { CapabilityBinding, Config } from './config.js'
import { GATED_STAGES } from './state.js'

export interface RuntimeSkill {
  name: string
  source: 'runtime'
  description: string
  whenToUse: string
  content: string
}

function renderBinding(label: string, binding: CapabilityBinding): string {
  const all = binding.workflows.filter((name) => name.trim() !== '')
  if (all.length === 0) {
    return '- **' + label + '**：未绑定。用 `comfyui_workflow` 的 `action: list` 列出工作流库，'
      + '挑一个合适的告诉用户，请他填进设置，再继续。**不要自己挑一个就跑。**'
  }
  const note = binding.notes.trim() === '' ? '' : '　—　' + binding.notes.trim()
  const others = all.slice(1)
  const rest = others.length === 0 ? '' : '（备选：' + others.map((n) => '`' + n + '`').join('、') + '）'
  return '- **' + label + '**：`' + all[0] + '`' + rest + note
}

export function buildPipelineSkill(config: Config): RuntimeSkill {
  const gates = GATED_STAGES.size

  const content = `# AI 视频创作工作台

把一句话做成一条带配音、配图、字幕的解说片。四段状态机，顺序固定，**一步都不能跳**：

\`\`\`
brief ──[闸]──> script ──[闸]──> assets ──[闸]──> compose
\`\`\`

${gates} 个闸都排在花钱之前：brief / script 挡住「脚本没定就去跑生成」，assets 让素材过目后再合成。

## 节点

| # | 阶段 | 这一步定什么 | 闸 |
|---|---|---|---|
| 1 | \`brief\` | 主题、受众、时长、投放平台、风格 | 是 |
| 2 | \`script\` | 分镜脚本：每段旁白 + 画面说明 + 绘图提示词 | 是 |
| 3 | \`assets\` | 每段的配音 + 画面（图或视频）+ 可选配乐 | 是 |
| 4 | \`compose\` | FFmpeg 合成出成片 + 字幕 | 否 |

## 工具

- \`workbench_project\` —— 项目与文件：init / status / list / get / import / bindings。**不推进状态。**
- \`workbench_stage\` —— **推进状态的唯一入口**。每次写入都会被检查。
- \`workbench_compose\` —— 渲染成片并返回报告。**不推进状态**，报告要经 workbench_stage 记录。

## 红线

**推进状态只能调 \`workbench_stage\`。** 它做 schema 校验、审批闸校验、前置校验、
资产存在性校验，任何一条不过就抛错，没有「提示一下但还是写进去」。看到
\`GATE VIOLATION\` / \`PREREQUISITE VIOLATION\` / \`ASSET MISSING\` /
\`COVERAGE INCOMPLETE\` 不要绕，回去补。工具契约见 \`dsh-ai-video-workbench-usage\`。

**审批闸协议**（brief / script / assets）：

1. 写 \`status: "awaiting_human"\`，带上完整产物
2. 用中文把产物要点讲给用户听（不要贴 JSON）
3. **结束你这一轮**，等用户真的回话
4. 用户认可后，再写 \`status: "completed"\` + \`human_approved: true\`

直接写 \`completed\` 会被 \`GATE VIOLATION\` 挡回来。用户没说「可以/继续/就这样」之前，
\`human_approved\` 永远是 false。

**重写早期阶段会作废后续阶段。** 用户在素材做完之后改脚本，后面几段必须重做。

## 生成：走 dsh-comfyui

本插件**不直接连 ComfyUI**。图像 / 配音 / 配乐一律由你调 \`comfyui_workflow\` 完成。

绑定表只告诉用哪条工作流，不复述参数：

${renderBinding('配音（TTS）', config.bindings.tts)}
${renderBinding('配图（txt2img）', config.bindings.image)}
${renderBinding('配乐（音乐）', config.bindings.music)}

- **参数怎么传**：调 \`comfyui_workflow action: "list"\`，那份清单是权威（参数名、默认值、options 下拉）。
- **提示词怎么写**：\`comfyui_workflow action: "skill"\`，每个工作流可带自己的技能包。
- 调用的姿势：action 用工作流 **id**（不是名称）；run 的覆盖值包在 \`parameters: { ... }\` 里；
  音频 / 视频工作流用 \`mode: "async"\`。
- 清单里找不到绑定那条工作流 → 告诉用户，不要顺手换一条跑。

## 生成流程（assets 阶段）

1. 先配音：样音先行，满意后按脚本逐段批量生成，产物用 \`workbench_project action: "import"\` 收进项目。
2. 再配图：按脚本每段的 \`visual.prompt\` 生成，同样 import 进来。
3. 把每段素材记录进 \`asset_manifest\`（每段至少一条 narration + 一张 image 或一段 video），
   配乐（music）整片一条、scene_id 留空。
4. 时长以 ffprobe 实测为准——状态机在写入时会自动回填，别在清单里写编的时长。

## 不要做的事

- 不要用文件工具直接改 \`checkpoints/\` 或 \`artifacts/\`，那是状态机的私有存储
- 不要在用户没确认时替他确认
- 不要为绕过校验编造路径或时长
`

  return {
    name: 'dsh-ai-video-workbench',
    source: 'runtime',
    description: 'AI 视频创作工作台：brief → script → assets → compose 四段状态机、三个人工审批闸，'
      + '生成走 dsh-comfyui 工作流、合成走 FFmpeg。'
      + '处理 workbench_project / workbench_stage / workbench_compose，或用户要做解说片时加载。',
    whenToUse: '用户要做解说片、宣传片一类的短视频，或要求推进已有的工作台项目时。',
    content,
  }
}

export function buildUsageSkill(): RuntimeSkill {
  const content = `# AI 视频创作工作台：工具契约

三个工具，一个写入口：

- \`workbench_project\`：项目与文件。action 有 init / status / list / get / import / bindings。
- \`workbench_stage\`：推进状态。project + stage + status，artifact 包在 artifacts 里。
- \`workbench_compose\`：渲染。project + 可选 burn_subtitles，返回 render_report，不推进状态。

## 报错怎么处置

| 错误码 | 含义 | 处置 |
|---|---|---|
| \`GATE VIOLATION\` | 审批闸阶段写成 completed 但没 human_approved | 先 awaiting_human，等用户批准 |
| \`PREREQUISITE VIOLATION\` | 前面的阶段没完成 | 回去补，按顺序来 |
| \`SCHEMA INVALID\` | 工件结构不对 | 按报错里的字段改，重写 |
| \`ASSET MISSING\` | 清单里的文件不存在 | import 进来或改对路径 |
| \`COVERAGE INCOMPLETE\` | 有段落缺配音或缺画面 | 补齐再写 completed |

任何一条都是「确实漏了一步」，不是让你换条路绕过去。

## 状态机语义

- 阶段状态：\`in_progress\`（进行中）/ \`awaiting_human\`（停在闸前）/ \`completed\`（完成）/ \`failed\`（死路）。
- \`workbench_project action: "status"\` 返回每个阶段的进度、下一个阶段、是否停在审批闸。
  做任何事之前先调它，别凭记忆。
- 重写早期阶段会作废其后所有阶段（archive 删除 checkpoint），必须重做。

## import 规则

- 来源可以是本地绝对路径，或 dsh-comfyui 媒体代理的 http(s) 链接。
- 每个 item 带 \`kind\`（narration / image / video / music）和 \`scene_id\`（music 留空）。
- 返回的是项目内相对路径，原样填进 asset_manifest，不要自己改。
`

  return {
    name: 'dsh-ai-video-workbench-usage',
    source: 'runtime',
    description: 'AI 视频创作工作台的工具契约与报错处置：三个工具各管什么、错误码怎么读、状态机语义。'
      + '工具报错或拿不准参数时加载。',
    whenToUse: '调用 workbench_* 工具报错、拿不准参数、或想确认状态机语义时。',
    content,
  }
}

export function buildSkills(config: Config): RuntimeSkill[] {
  return [buildPipelineSkill(config), buildUsageSkill()]
}
