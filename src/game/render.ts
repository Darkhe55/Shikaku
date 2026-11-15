/**
 * 数方 —— SVG 渲染与命中
 *
 * 视觉层次（从下到上）：
 *   棋盘底 → 矩形填色 → 网格 → 矩形粗边界 → 数字 → 错误高亮 → 选中格 → 拖拽预览 → 命中层
 *
 * 拖拽过程中的预览走 addLivePreview() 就地更新，不整盘重绘，
 * 这样指针捕获和手势状态不会因为 DOM 被替换而中断。
 */

import type { BoardMetrics, GameState, Puzzle, ValidationResult } from '../core/types'
import {
  asShikakuPuzzle,
  asShikakuState,
  clueAt,
  rectCells,
  type Rect,
  type ShikakuResult,
} from './types'
import { uiState, type PreviewRect } from './ui-state'

/** 矩形填色（按矩形 id 循环，淡色保证数字清晰） */
const RECT_FILLS = [
  'hsl(160 34% 92%)',
  'hsl(38 48% 92%)',
  'hsl(210 40% 92%)',
  'hsl(282 30% 93%)',
  'hsl(2 42% 93%)',
  'hsl(185 34% 91%)',
  'hsl(62 40% 92%)',
  'hsl(322 28% 93%)',
  'hsl(104 30% 92%)',
  'hsl(18 44% 92%)',
  'hsl(242 28% 93%)',
  'hsl(196 36% 91%)',
]

export function rectFill(id: number): string {
  const n = RECT_FILLS.length
  return RECT_FILLS[((id % n) + n) % n]!
}

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  const maxDim = Math.max(puzzle.width, puzzle.height)
  const cell =
    maxDim <= 6 ? 58 : maxDim <= 8 ? 52 : maxDim <= 10 ? 47 : maxDim <= 12 ? 43 : maxDim <= 16 ? 37 : 32
  const pad = Math.round(cell * 0.52)
  return {
    cell,
    pad,
    width: puzzle.width,
    height: puzzle.height,
    svgWidth: pad * 2 + puzzle.width * cell,
    svgHeight: pad * 2 + puzzle.height * cell,
    k: 1,
    targetKind: 'cell',
  }
}

/* ────────────────────────── 坐标工具 ────────────────────────── */

function cellXY(m: BoardMetrics, cell: number): { x: number; y: number } {
  return {
    x: m.pad + (cell % m.width) * m.cell,
    y: m.pad + Math.floor(cell / m.width) * m.cell,
  }
}

/* ────────────────────────── 预览 ────────────────────────── */

function previewMarkup(m: BoardMetrics, preview: PreviewRect): string {
  const x = m.pad + preview.x * m.cell
  const y = m.pad + preview.y * m.cell
  const w = preview.w * m.cell
  const h = preview.h * m.cell
  const cls = preview.status === 'ok' ? 'ok' : preview.status === 'warn' ? 'warn' : 'bad'
  const parts: string[] = []
  parts.push(
    `<rect class="shk-preview-fill ${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${(m.cell * 0.16).toFixed(2)}" />`,
  )
  parts.push(
    `<rect class="shk-preview-ring ${cls}" x="${(x + 1.5).toFixed(2)}" y="${(y + 1.5).toFixed(2)}" width="${(w - 3).toFixed(2)}" height="${(h - 3).toFixed(2)}" rx="${(m.cell * 0.13).toFixed(2)}" />`,
  )
  if (preview.area > 0) {
    const label = `${preview.area}`
    const fx = (x + w - m.cell * 0.2).toFixed(2)
    const fy = (y + m.cell * 0.28).toFixed(2)
    parts.push(
      `<text class="shk-preview-area ${cls}" x="${fx}" y="${fy}" style="font-size:${(m.cell * 0.26).toFixed(2)}px">${label}</text>`,
    )
  }
  return parts.join('')
}

export function previewLayerMarkup(m: BoardMetrics): string {
  const p = uiState.preview
  return `<g id="shk-preview-layer" class="shk-preview-layer">${p ? previewMarkup(m, p) : ''}</g>`
}

/** 拖拽中就地更新预览层（不重绘整盘） */
export function addLivePreview(svg: SVGSVGElement, m: BoardMetrics, preview: PreviewRect | null): void {
  let layer = svg.querySelector<SVGGElement>('#shk-preview-layer')
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    layer.setAttribute('id', 'shk-preview-layer')
    layer.setAttribute('class', 'shk-preview-layer')
    svg.appendChild(layer)
  }
  layer.innerHTML = preview ? previewMarkup(m, preview) : ''
}

/* ────────────────────────── 棋盘渲染 ────────────────────────── */

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
): string {
  const m = metricsFor(puzzle)
  const p = asShikakuPuzzle(puzzle)
  const s = asShikakuState(state)
  const r = result as ShikakuResult
  const w = puzzle.width
  const h = puzzle.height
  const size = w * h
  const cell = m.cell
  const bad = new Set<number>(r.badCells ?? [])
  const overlap = new Set<number>(r.overlapCells ?? [])
  const issuesById = new Map<number, ShikakuResult['rectIssues'][number]>()
  for (const issue of r.rectIssues ?? []) issuesById.set(issue.rectId, issue)

  const parts: string[] = []
  const bw = m.pad * 2 + w * cell
  const bh = m.pad * 2 + h * cell

  parts.push(
    `<defs><pattern id="shk-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="rgba(194,59,46,0.55)" stroke-width="2.2" /></pattern></defs>`,
  )
  parts.push(
    `<rect class="shk-board-bg" x="${(m.pad - 10).toFixed(2)}" y="${(m.pad - 10).toFixed(2)}" width="${(w * cell + 20).toFixed(2)}" height="${(h * cell + 20).toFixed(2)}" rx="${(cell * 0.24).toFixed(2)}" />`,
  )

  /* —— 1. 矩形填色 —— */
  const fillParts: string[] = []
  for (let id = 0; id < s.rects.length; id++) {
    const rect = s.rects[id]
    if (!rect) continue
    const x = m.pad + rect.x * cell
    const y = m.pad + rect.y * cell
    const rw = rect.w * cell
    const rh = rect.h * cell
    const issue = issuesById.get(id)
    const cls = issue ? `shk-rect-${issue.kind}` : ''
    fillParts.push(
      `<rect class="shk-rect${cls ? ` ${cls}` : ''}" data-rect="${id}" x="${(x + 1).toFixed(2)}" y="${(y + 1).toFixed(2)}" width="${(rw - 2).toFixed(2)}" height="${(rh - 2).toFixed(2)}" rx="${(cell * 0.16).toFixed(2)}" fill="${rectFill(id)}" />`,
    )
    if (issue && issue.kind !== 'overlap') {
      const label =
        issue.kind === 'area'
          ? `${rect.w * rect.h}≠${clueValueOf(p.givens, rectCells(rect, w))}`
          : issue.kind === 'noClue'
            ? '无数字'
            : issue.kind === 'multiClue'
              ? '多数字'
              : '越界'
      fillParts.push(
        `<text class="shk-rect-tag" x="${(x + rw / 2).toFixed(2)}" y="${(y + rh / 2 + cell * 0.36).toFixed(2)}" style="font-size:${(cell * 0.2).toFixed(2)}px">${label}</text>`,
      )
    }
  }
  parts.push(`<g class="shk-fills">${fillParts.join('')}</g>`)

  /* —— 2. 网格线 —— */
  const gridParts: string[] = []
  for (let x = 0; x <= w; x++) {
    const gx = m.pad + x * cell
    gridParts.push(
      `<line class="shk-grid" x1="${gx.toFixed(2)}" y1="${m.pad}" x2="${gx.toFixed(2)}" y2="${(m.pad + h * cell).toFixed(2)}" />`,
    )
  }
  for (let y = 0; y <= h; y++) {
    const gy = m.pad + y * cell
    gridParts.push(
      `<line class="shk-grid" x1="${m.pad}" y1="${gy.toFixed(2)}" x2="${(m.pad + w * cell).toFixed(2)}" y2="${gy.toFixed(2)}" />`,
    )
  }
  parts.push(`<g class="shk-grid-lines">${gridParts.join('')}</g>`)

  /* —— 3. 矩形粗边界 —— */
  const regions = new Int32Array(size).fill(-1)
  for (let id = 0; id < s.rects.length; id++) {
    const rect = s.rects[id]
    if (!rect) continue
    for (const c of rectCells(rect, w)) if (regions[c] < 0) regions[c] = id
  }
  const seen = new Set<string>()
  const boundaryParts: string[] = []
  const addLine = (x1: number, y1: number, x2: number, y2: number): void => {
    const key = `${x1.toFixed(1)},${y1.toFixed(1)},${x2.toFixed(1)},${y2.toFixed(1)}`
    if (seen.has(key)) return
    seen.add(key)
    boundaryParts.push(
      `<line class="shk-boundary" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" />`,
    )
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const region = regions[i]!
      const x0 = m.pad + x * cell
      const y0 = m.pad + y * cell
      const left = x > 0 ? regions[i - 1]! : -2
      const up = y > 0 ? regions[i - w]! : -2
      const right = x + 1 < w ? regions[i + 1]! : -2
      const down = y + 1 < h ? regions[i + w]! : -2
      if (left !== region) addLine(x0, y0, x0, y0 + cell)
      if (up !== region) addLine(x0, y0, x0 + cell, y0)
      if (right !== region) addLine(x0 + cell, y0, x0 + cell, y0 + cell)
      if (down !== region) addLine(x0, y0 + cell, x0 + cell, y0 + cell)
    }
  }
  parts.push(`<g class="shk-boundaries">${boundaryParts.join('')}</g>`)

  /* —— 4. 数字 —— */
  const clueParts: string[] = []
  for (let c = 0; c < size; c++) {
    const value = clueAt(p, c)
    if (value <= 0) continue
    const { x, y } = cellXY(m, c)
    const isBad = bad.has(c)
    const fontSize = value >= 10 ? cell * 0.42 : cell * 0.5
    clueParts.push(
      `<text class="shk-clue${isBad ? ' bad' : ''}" data-clue="${c}" x="${(x + cell / 2).toFixed(2)}" y="${(y + cell / 2 + cell * 0.015).toFixed(2)}" style="font-size:${fontSize.toFixed(2)}px">${value}</text>`,
    )
  }
  parts.push(`<g class="shk-clues">${clueParts.join('')}</g>`)

  /* —— 5. 错误高亮 —— */
  const errorParts: string[] = []
  for (let id = 0; id < s.rects.length; id++) {
    const rect = s.rects[id]
    if (!rect) continue
    const issue = issuesById.get(id)
    if (!issue || issue.kind === 'overlap') continue
    const x = m.pad + rect.x * cell
    const y = m.pad + rect.y * cell
    errorParts.push(
      `<rect class="shk-rect-error" x="${(x + 1).toFixed(2)}" y="${(y + 1).toFixed(2)}" width="${(rect.w * cell - 2).toFixed(2)}" height="${(rect.h * cell - 2).toFixed(2)}" rx="${(cell * 0.16).toFixed(2)}" />`,
    )
  }
  for (const c of bad) {
    if (overlap.has(c)) continue
    const { x, y } = cellXY(m, c)
    errorParts.push(
      `<rect class="shk-bad-cell" x="${(x + 2).toFixed(2)}" y="${(y + 2).toFixed(2)}" width="${(cell - 4).toFixed(2)}" height="${(cell - 4).toFixed(2)}" rx="${(cell * 0.12).toFixed(2)}" />`,
    )
  }
  for (const c of overlap) {
    const { x, y } = cellXY(m, c)
    errorParts.push(
      `<rect class="shk-overlap-cell" x="${(x + 2).toFixed(2)}" y="${(y + 2).toFixed(2)}" width="${(cell - 4).toFixed(2)}" height="${(cell - 4).toFixed(2)}" rx="${(cell * 0.12).toFixed(2)}" fill="url(#shk-hatch)" />`,
    )
  }
  parts.push(`<g class="shk-errors">${errorParts.join('')}</g>`)

  /* —— 6. 选中格 —— */
  const cursor = uiState.cursor
  if (cursor != null && cursor >= 0 && cursor < size) {
    const { x, y } = cellXY(m, cursor)
    const inset = Math.max(2.5, cell * 0.06)
    parts.push(
      `<g class="shk-cursor"><rect class="shk-cursor-ring" x="${(x + inset).toFixed(2)}" y="${(y + inset).toFixed(2)}" width="${(cell - inset * 2).toFixed(2)}" height="${(cell - inset * 2).toFixed(2)}" rx="${(cell * 0.14).toFixed(2)}" /><circle class="shk-cursor-dot" cx="${(x + cell / 2).toFixed(2)}" cy="${(y + cell / 2).toFixed(2)}" r="${(cell * 0.06).toFixed(2)}" /></g>`,
    )
  }

  /* —— 7. 预览层 —— */
  parts.push(previewLayerMarkup(m))

  /* —— 8. 命中层 —— */
  for (let c = 0; c < size; c++) {
    const { x, y } = cellXY(m, c)
    parts.push(
      `<rect class="cell-hit shk-hit" data-index="${c}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" />`,
    )
  }

  return `<svg class="board-svg shk-board" viewBox="0 0 ${bw} ${bh}" width="${bw}" height="${bh}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

/** 取矩形内唯一数字的值（用于错误标签）；没有返回 0 */
function clueValueOf(givens: ArrayLike<number>, cells: number[]): number {
  for (const c of cells) {
    const v = givens[c] ?? 0
    if (v > 0) return v
  }
  return 0
}

/* ────────────────────────── 命中 ────────────────────────── */

export function hitTest(
  m: BoardMetrics,
  puzzle: Puzzle,
  x: number,
  y: number,
): { index: number } | null {
  const col = Math.floor((x - m.pad) / m.cell)
  const row = Math.floor((y - m.pad) / m.cell)
  if (col < 0 || row < 0 || col >= puzzle.width || row >= puzzle.height) return null
  return { index: row * puzzle.width + col }
}

/* ────────────────────────── 落子特效 ────────────────────────── */

/** 矩形落子 / 删除特效：对矩形区域做一次淡入-扩散 */
export function flashRect(
  svg: SVGSVGElement,
  m: BoardMetrics,
  rect: Rect,
  kind: 'add' | 'remove',
  streak: number,
): void {
  if (!svg.isConnected) return
  const NS = 'http://www.w3.org/2000/svg'
  const x = m.pad + rect.x * m.cell
  const y = m.pad + rect.y * m.cell
  const g = document.createElementNS(NS, 'g')
  g.setAttribute('class', `shk-flash shk-flash-${kind}`)
  const r = document.createElementNS(NS, 'rect')
  r.setAttribute('x', String(x + 1))
  r.setAttribute('y', String(y + 1))
  r.setAttribute('width', String(rect.w * m.cell - 2))
  r.setAttribute('height', String(rect.h * m.cell - 2))
  r.setAttribute('rx', String(m.cell * 0.16))
  g.appendChild(r)
  svg.appendChild(g)
  const duration = Math.max(320, 560 / Math.sqrt(Math.max(1, streak)))
  setTimeout(() => g.remove(), duration)
}
