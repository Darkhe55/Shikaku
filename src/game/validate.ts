/**
 * 数方 —— 实时校验与错误明细
 *
 * 检查项：
 *   - 未覆盖格 / 数字未被使用；
 *   - 矩形面积与数字不符；
 *   - 矩形内没有数字 / 含多个数字；
 *   - 矩形重叠；
 *   - 矩形越界（一般只可能来自异常存档）。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import {
  asShikakuPuzzle,
  asShikakuState,
  clueAt,
  rectCells,
  type RectIssue,
  type RectIssueKind,
  type ShikakuResult,
} from './types.ts'

export function validate(state: GameState, puzzle: Puzzle): ShikakuResult {
  const s = asShikakuState(state)
  const p = asShikakuPuzzle(puzzle)
  const w = s.width
  const h = s.height
  const size = w * h
  const owner = new Int32Array(size).fill(-1)
  const overlapCells = new Set<number>()
  const badCells = new Set<number>()
  const rectIssues: RectIssue[] = []
  const outsideRects: number[] = []
  const uncoveredClues: number[] = []

  let covered = 0

  const liveRects: Array<{ id: number; cells: number[]; area: number; outside: boolean }> = []

  /* —— 1. 记录每个格子的归属并检测重叠 / 越界 —— */
  for (let id = 0; id < s.rects.length; id++) {
    const rect = s.rects[id]
    if (!rect) continue
    const insideX = rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= w && rect.y + rect.h <= h
    const positive = rect.w >= 1 && rect.h >= 1
    const outside = !insideX || !positive
    if (outside) outsideRects.push(id)

    const cells: number[] = []
    if (outside) {
      // 只统计盘内的部分，用于高亮
      const x0 = Math.max(0, rect.x)
      const y0 = Math.max(0, rect.y)
      const x1 = Math.min(w, rect.x + rect.w)
      const y1 = Math.min(h, rect.y + rect.h)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells.push(y * w + x)
    } else {
      for (const c of rectCells(rect, w)) cells.push(c)
    }
    liveRects.push({ id, cells, area: rect.w * rect.h, outside })

    for (const c of cells) {
      if (owner[c] >= 0) overlapCells.add(c)
      else owner[c] = id
    }
  }

  /* —— 2. 逐矩形检查数字与面积 —— */
  for (const live of liveRects) {
    if (live.outside) {
      rectIssues.push({
        rectId: live.id,
        kind: 'outside',
        cells: live.cells,
        area: live.area,
        clueCount: 0,
      })
      for (const c of live.cells) badCells.add(c)
      continue
    }
    let clues = 0
    let clueValue = 0
    let overlapHere = false
    for (const c of live.cells) {
      if (clueAt(p, c) > 0) {
        clues++
        clueValue = clueAt(p, c)
      }
      if (overlapCells.has(c)) overlapHere = true
    }

    let kind: RectIssueKind | null = null
    if (overlapHere) kind = 'overlap'
    else if (clues === 0) kind = 'noClue'
    else if (clues > 1) kind = 'multiClue'
    else if (clueValue !== live.area) kind = 'area'

    if (kind) {
      rectIssues.push({
        rectId: live.id,
        kind,
        cells: live.cells,
        area: live.area,
        clueCount: clues,
      })
      for (const c of live.cells) badCells.add(c)
    }
  }

  /* —— 3. 未覆盖格 / 数字未使用 —— */
  for (let c = 0; c < size; c++) {
    if (owner[c] >= 0) {
      covered++
      continue
    }
    if (clueAt(p, c) > 0) {
      uncoveredClues.push(c)
      badCells.add(c)
    }
  }
  for (const c of overlapCells) badCells.add(c)

  const complete = covered === size
  const hasIssue = rectIssues.length > 0 || overlapCells.size > 0 || uncoveredClues.length > 0
  const solved = complete && !hasIssue

  return {
    solved,
    empty: size - covered,
    covered,
    total: size,
    complete,
    rectCount: liveRects.length,
    rectIssues,
    badCells: Array.from(badCells),
    overlapCells: Array.from(overlapCells),
    uncoveredClues,
    outsideRects,
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as ShikakuResult
  if (r.solved) return ['完成']

  const bits: string[] = []
  if (typeof r.empty === 'number' && r.empty > 0) bits.push(`还差 ${r.empty} 格未覆盖`)

  const count = (kind: RectIssueKind) => r.rectIssues.filter((x) => x.kind === kind).length
  const area = count('area')
  const noClue = count('noClue')
  const multi = count('multiClue')
  if (area > 0) bits.push(`${area} 个矩形面积与数字不符`)
  if (noClue > 0) bits.push(`${noClue} 个矩形没有数字`)
  if (multi > 0) bits.push(`${multi} 个矩形含多个数字`)
  if (r.overlapCells.length > 0) bits.push(`${r.overlapCells.length} 格被多个矩形覆盖`)
  if (r.uncoveredClues.length > 0) bits.push(`${r.uncoveredClues.length} 个数字未被使用`)
  if (r.outsideRects.length > 0) bits.push(`${r.outsideRects.length} 个矩形越界`)

  if (bits.length === 0) bits.push(r.complete ? '仍有问题' : '继续推理')
  return bits
}
