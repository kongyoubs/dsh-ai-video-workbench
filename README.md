# dsh-ai-video-workbench

**AI 视频创作工作台 · DeepSeek Harness 插件版**：把一句话变成一条带配音、配图、字幕的解说片。生成走 **dsh-comfyui** 工作流，合成走 **FFmpeg**。

**定位：对话驱动管线。** 用自然语言说想法，Agent 通过工具推进状态机、调用 dsh-comfyui 生成、FFmpeg 合成成片。本插件是纯管线内核（状态机 + 工具 + 技能），不包含画布或网页面板。

## 安装

前置：DeepSeek Harness、[dsh-comfyui](https://github.com/fandc520/dsh-comfyui) ≥ 0.4.0、Node ≥ 22.19、PATH 上的 `ffmpeg` / `ffprobe`。

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <你的 profile> add dsh-ai-video-workbench
```

装完重启 profile。配置在 cordis.yml 的 `workbench` 层：

```yaml
workbench:
  workspaceRoot: ''            # 留空 = $DSH_HOME/data/dsh-ai-video-workbench/projects
  ffmpegPath: ffmpeg
  ffprobePath: ffprobe
  defaultDurationSeconds: 30
  language: zh
  bindings:
    tts:    { workflows: [你的TTS工作流名], notes: '' }
    image:  { workflows: [你的文生图工作流名], notes: '' }
    music:  { workflows: [], notes: '' }
```

## 管线

```
brief ──[闸]──> script ──[闸]──> assets ──[闸]──> compose
```

- **brief**：主题、受众、时长、投放平台、风格。
- **script**：分镜脚本（每段旁白 + 画面说明 + 绘图提示词）。
- **assets**：每段的配音 + 画面（图/视频）+ 可选配乐，经 dsh-comfyui 生成后 import 进项目。
- **compose**：FFmpeg 按实测配音时长排时间轴，输出成片 + SRT。

前三个阶段是**人工审批闸**：Agent 必须先 `awaiting_human` 概述给你，等你认可后才 `completed`。

## 工具（Agent 用）

| 工具 | 作用 |
| --- | --- |
| `workbench_project` | 项目与文件：init / status / list / get / import / bindings |
| `workbench_stage` | **推进状态的唯一入口**，每次写入都做 schema/闸/前置/素材校验 |
| `workbench_compose` | FFmpeg 渲染并返回报告（不推进状态） |
| `workbench_show` | 把项目里的成片/素材放进对话给用户预览 |

## 技能（Agent 读）

- `dsh-ai-video-workbench`：管线地图 + 红线 + 审批协议 + dsh-comfyui 绑定。
- `dsh-ai-video-workbench-usage`：工具契约 + 报错处置。

## 目录结构

```
src/
├── index.ts        # apply 入口：注册 tools + skills
├── config.ts       # schemastery 配置 + dsh-comfyui bindings
├── state.ts        # 状态机（闸门 + 前置 + 校验 + 作废）
├── schema.ts       # brief/script/asset_manifest/render_report 结构与校验
├── project.ts      # 工作区目录布局 + 项目 marker
├── tools.ts        # 四个工具定义（project / stage / compose / show）
├── compose.ts      # FFmpeg 合成（Ken Burns / 视频循环 + 旁白 + 配乐 + 字幕）
└── skills.ts       # 运行时技能
```

## 许可

MIT
