/**
 * 数方 —— 题库加载
 *
 * puzzles-data.ts 由 scripts/gen-config.mjs + scripts/gen-puzzles.mjs 生成：
 *   board    = 每格一个 base36 字符（0 = 无数字，1–9/a… = 数字）
 *   solution = 矩形列表 `x,y,w,h;x,y,w,h;...`
 *
 * 加载时会把参考解重新校验一遍（面积 / 数字 / 覆盖），不合法的题会被跳过并告警。
 */

import { RAW_PUZZLES } from './puzzles-data'
import {
  clueCountOf,
  decodeClues,
  decodeRects,
  type Rect,
  type ShikakuPuzzle,
  type ShikakuState,
} from './types'
import { validateRects } from './solver'
import { stateFromRects } from './state'

export const builtinPuzzles: ShikakuPuzzle[] = []
const solutions = new Map<string, Rect[]>()

for (const raw of RAW_PUZZLES) {
  const size = raw.width * raw.height
  const givens = decodeClues(raw.board, size)
  if (!givens) {
    console.warn(`[数方] 题面解码失败：${raw.id}`)
    continue
  }
  if (clueCountOf(givens) === 0) {
    console.warn(`[数方] 题目没有任何数字：${raw.id}`)
    continue
  }

  const puzzle: ShikakuPuzzle = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    givens,
  }
  builtinPuzzles.push(puzzle)

  if (raw.solution) {
    const decoded = decodeRects(raw.solution, raw.width, raw.height)
    if (!decoded) {
      console.warn(`[数方] 参考解解码失败：${raw.id}`)
      continue
    }
    const rects = decoded.filter((r): r is Rect => !!r)
    const check = validateRects(raw.width, raw.height, givens, rects)
    if (!check.ok) {
      console.warn(`[数方] 参考解不合法（${raw.id}）：${check.reason ?? ''}`)
      continue
    }
    puzzle.solution = rects
    solutions.set(raw.id, rects)
  }
}

/** 参考解（显示解 / 提示一格用） */
export function getReferenceSolution(id: string): ShikakuState | null {
  const rects = solutions.get(id)
  if (!rects) return null
  const puzzle = builtinPuzzles.find((p) => p.id === id)
  if (!puzzle) return null
  return stateFromRects(puzzle.id, puzzle.width, puzzle.height, rects)
}

export function puzzleById(id: string): ShikakuPuzzle | undefined {
  return builtinPuzzles.find((p) => p.id === id)
}

export function referenceFor(puzzle: ShikakuPuzzle): Rect[] | null {
  return puzzle.solution ?? solutions.get(puzzle.id) ?? null
}
