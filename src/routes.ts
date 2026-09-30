/**
 * 浏览器侧最小数据面：一个媒体路由。
 *
 *   GET /workbench/media?project=<id>&path=<相对路径>
 *
 * 用于把项目里的成片/素材放进对话里预览（workbench_show 工具的 media 卡片）。
 * 路径经 resolveInProject 校验，拒绝绝对路径与 `..`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, join } from 'node:path'

import { type PluginRuntime } from './tools.js'
import { ProjectError, resolveInProject } from './project.js'

interface WebServer {
  register(route: {
    kind: string
    path: string
    handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
  }): () => void
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.srt': 'text/plain',
}

function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function mediaUrl(projectId: string, relative: string): string {
  return '/workbench/media?project=' + encodeURIComponent(projectId) + '&path=' + encodeURIComponent(relative)
}

export function mediaKindOf(relative: string): string {
  const ext = extname(relative).toLowerCase()
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image'
  if (['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) return 'audio'
  return 'other'
}

function queryOf(request: IncomingMessage): URLSearchParams {
  const raw = (request.url ?? '').split('?')[1] ?? ''
  return new URLSearchParams(raw)
}

type RangeResult = { start: number; end: number } | 'invalid' | null

/** 解析合法单范围请求；非法返回 'invalid'，无范围返回 null。 */
function parseRange(range: string, size: number): RangeResult {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (match === null) return 'invalid'
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return 'invalid'
  if (startRaw === '') {
    // 后缀范围：bytes=-500 → 末尾 500 字节
    const suffix = parseInt(endRaw!, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = parseInt(startRaw!, 10)
  if (!Number.isFinite(start) || start < 0 || start >= size) return 'invalid'
  let end = endRaw === '' ? size - 1 : parseInt(endRaw!, 10)
  if (!Number.isFinite(end) || end < start) return 'invalid'
  end = Math.min(end, size - 1)
  return { start, end }
}

async function sendFile(request: IncomingMessage, response: ServerResponse, absolutePath: string): Promise<void> {
  const stat = await fs.stat(absolutePath)
  const mime = mimeOf(absolutePath)

  if (request.method === 'HEAD') {
    response.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    })
    response.end()
    return
  }

  const range = request.headers.range
  if (range !== undefined) {
    const parsed = parseRange(range, stat.size)
    if (parsed === 'invalid') {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      response.end()
      return
    }
    if (parsed !== null) {
      const { start, end } = parsed
      response.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      })
      const stream = createReadStream(absolutePath, { start, end })
      stream.on('error', () => response.destroy())
      stream.pipe(response)
      return
    }
  }

  response.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  })
  const stream = createReadStream(absolutePath)
  stream.on('error', () => response.destroy())
  stream.pipe(response)
}

export function mountWorkbenchRoutes(ctx: Context, runtime: PluginRuntime): (() => void) | undefined {
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer === undefined) return undefined

  const disposers: Array<() => void> = []
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/workbench/media',
    handler: async (request, response) => {
      try {
        const params = queryOf(request)
        const projectId = params.get('project')
        const relative = params.get('path')
        if (projectId === null || relative === null) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'project and path are required' }))
          return
        }
        const { layout } = await runtime.machine.requireProject(projectId)
        let absolute: string
        try {
          absolute = resolveInProject(layout, relative)
        } catch (error) {
          if (error instanceof ProjectError) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: error.message }))
            return
          }
          throw error
        }
        await sendFile(request, response, absolute)
      } catch {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'not found' }))
      }
    },
  }))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
