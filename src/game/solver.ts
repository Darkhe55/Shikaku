/**
 * 数方 —— 候选矩形枚举 + 回溯求解
 *
 * 核心事实：每个格子的归属只有一种可能——它所在的矩形必须包含某个数字，
 * 面积等于该数字。所以我们先为每个数字枚举出「面积 = 数字、只含这一个数字」
 * 的所有候选矩形；求解就是从某个未覆盖格子出发，尝试覆盖它的候选矩形。
 *
 * 剪枝：
 *   - 候选矩形面积固定，天然满足面积约束；
 *   - 一旦放下矩形，所有与它相交的候选矩形立即失效；
 *   - 每次选择「剩余候选最少」的未覆盖格子（MRV），失败立刻回溯。
 */

import type { Puzzle, SolveResult } from '../core/types'
import {
  asShikakuPuzzle,
  clueAt,
  clueCountOf,
  inBounds,
  rectCells,
  type Rect,
  type ShikakuPuzzle,
  type ShikakuState,
} from './types.ts'
import { stateFromRects } from './state.ts'

/** 一个候选矩形 */
export interface Candidate {
  id: number
  /** 该候选所属的数字格索引 */
  clue: number
  rect: Rect
  cells: number[]
  area: number
}

export interface CandidateIndex {
  candidates: Candidate[]
  /** 每个格子上可覆盖它的候选 id 列表 */
  cellCands: number[][]
  /** 每个数字格对应的候选 id 列表 */
  clueCands: number[][]
}

/**
 * 枚举全部候选矩形。
 * 只保留「矩形内恰好一个数字（且就是该数字格）」的矩形，面积必须等于数字。
 */
export function buildCandidates(puzzle: Puzzle): CandidateIndex {
  const p = asShikakuPuzzle(puzzle)
  const w = p.width
  const h = p.height
  const size = w * h
  const givens = p.givens ?? []
  const candidates: Candidate[] = []
  const cellCands: number[][] = Array.from({ length: size }, () => [])
  const clueCands: number[][] = Array.from({ length: size }, () => [])

  for (let cell = 0; cell < size; cell++) {
    const area = clueAt(p, cell)
    if (area <= 0) continue
    const cx = cell % w
    const cy = Math.floor(cell / w)

    // 枚举因数对 (rw, rh)，要求 rw*rh = area
    for (let rw = 1; rw <= Math.min(area, w); rw++) {
      if (area % rw !== 0) continue
      const rh = area / rw
      if (rh > h) continue
      // 左上角范围：矩形必须包含数字格
      const x0Min = Math.max(0, cx - rw + 1)
      const x0Max = Math.min(cx, w - rw)
      const y0Min = Math.max(0, cy - rh + 1)
      const y0Max = Math.min(cy, h - rh)
      for (let y0 = y0Min; y0 <= y0Max; y0++) {
        for (let x0 = x0Min; x0 <= x0Max; x0++) {
          const rect = { x: x0, y: y0, w: rw, h: rh }
          // 只能包含这一个数字
          let clues = 0
          const cells: number[] = []
          for (let y = y0; y < y0 + rh; y++) {
            for (let x = x0; x < x0 + rw; x++) {
              const idx = y * w + x
              cells.push(idx)
              if ((givens[idx] ?? 0) > 0) clues++
            }
          }
          if (clues !== 1) continue
          const id = candidates.length
          candidates.push({ id, clue: cell, rect, cells, area })
          clueCands[cell].push(id)
          for (const c of cells) cellCands[c]!.push(id)
        }
      }
    }
  }

  return { candidates, cellCands, clueCands }
}

/* ────────────────────────── 回溯搜索 ────────────────────────── */

interface SearchOptions {
  /** 最多找多少个解 */
  limit: number
  /** 搜索节点上限 */
  maxNodes: number
}

interface SearchOutcome {
  solutions: Rect[][]
  nodes: number
  timedOut: boolean
}

/**
 * 用候选矩形做精确覆盖搜索。
 * 复杂度靠「候选面积固定 + MRV」压住，正常 20×20 以内可用。
 */
export function searchSolutions(puzzle: Puzzle, options: SearchOptions): SearchOutcome {
  const p = asShikakuPuzzle(puzzle)
  const w = p.width
  const h = p.height
  const size = w * h
  const { candidates, cellCands } = buildCandidates(p)

  const solutions: Rect[][] = []
  const placed: Rect[] = []
  const placedCandidateIds: number[] = []
  const covered = new Uint8Array(size)
  const alive = new Uint8Array(candidates.length).fill(1)
  // 「被放下的矩形覆盖掉的候选」的记录栈，用于回溯恢复
  const killStack: number[][] = []
  let nodes = 0
  let timedOut = false

  const findUncovered = (): number => {
    for (let i = 0; i < size; i++) if (covered[i] === 0) return i
    return -1
  }

  /** 放下一个候选：覆盖格子，并杀掉所有与它相交的候选 */
  const place = (candId: number): void => {
    const cand = candidates[candId]!
    for (const c of cand.cells) covered[c] = 1
    const killed: number[] = []
    for (const c of cand.cells) {
      for (const other of cellCands[c]!) {
        if (alive[other]) {
          alive[other] = 0
          killed.push(other)
        }
      }
    }
    killStack.push(killed)
    placed.push(cand.rect)
    placedCandidateIds.push(candId)
  }

  const unplace = (): void => {
    const cand = candidates[placedCandidateIds.pop()!]!
    placed.pop()
    for (const c of cand.cells) covered[c] = 0
    const killed = killStack.pop()!
    for (const id of killed) alive[id] = 1
  }

  const dfs = (): void => {
    if (timedOut || solutions.length >= options.limit) return
    nodes++
    if (nodes > options.maxNodes) {
      timedOut = true
      return
    }

    const first = findUncovered()
    if (first < 0) {
      solutions.push(placed.map((r) => ({ ...r })))
      return
    }

    // MRV：在所有未覆盖格里挑候选最少的
    let bestList: number[] | null = null
    let bestCount = Number.POSITIVE_INFINITY
    for (let cell = first; cell < size; cell++) {
      if (covered[cell]) continue
      let count = 0
      let list: number[] | null = null
      for (const candId of cellCands[cell]!) {
        if (!alive[candId]) continue
        count++
        if (count >= bestCount) break
        if (!list) list = []
        list.push(candId)
      }
      if (count === 0) return // 死路
      if (count < bestCount) {
        bestCount = count
        bestList = list ?? []
        if (count === 1) break
      }
    }

    if (!bestList || bestList.length === 0) return

    for (const candId of bestList) {
      if (timedOut || solutions.length >= options.limit) return
      const pos = placed.length
      place(candId)
      dfs()
      while (placed.length > pos) unplace()
      if (timedOut) return
    }
  }

  dfs()
  return { solutions, nodes, timedOut }
}

/** 统计解的个数（最多到 limit 就停） */
export function countSolutions(
  puzzle: Puzzle,
  limit = 2,
  maxNodes = 600_000,
): { count: number; nodes: number; timedOut: boolean } {
  const out = searchSolutions(puzzle, { limit, maxNodes })
  return { count: out.solutions.length, nodes: out.nodes, timedOut: out.timedOut }
}

/** 找一个解；没有返回 null */
export function findSolution(
  puzzle: Puzzle,
  maxNodes = 1_200_000,
): { solution: Rect[] | null; nodes: number; timedOut: boolean } {
  const out = searchSolutions(puzzle, { limit: 1, maxNodes })
  return { solution: out.solutions[0] ?? null, nodes: out.nodes, timedOut: out.timedOut }
}

/** 模板契约：显示解 / 提示 / 自定义题求解 */
export function solvePuzzle(puzzle: Puzzle, maxNodes = 1_200_000): SolveResult {
  const p = asShikakuPuzzle(puzzle)
  const size = p.width * p.height
  if (!Array.isArray(p.givens) || p.givens.length !== size) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }
  if (clueCountOf(p.givens) === 0) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }

  const found = findSolution(puzzle, maxNodes)
  if (!found.solution) {
    return {
      solved: false,
      solution: null,
      nodes: found.nodes,
      timedOut: found.timedOut,
    }
  }
  const solution: ShikakuState = stateFromRects(p.id, p.width, p.height, found.solution)
  return { solved: true, solution, nodes: found.nodes, timedOut: false }
}

/**
 * 校验一个「矩形列表」是否构成合法解（不依赖盘面，check 脚本与题库加载都用它）。
 */
export function validateRects(
  width: number,
  height: number,
  givens: ArrayLike<number>,
  rects: Rect[],
): { ok: boolean; reason?: string } {
  const size = width * height
  if (rects.length === 0) return { ok: false, reason: '没有任何矩形' }
  const owner = new Int32Array(size).fill(-1)
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!
    if (!inBounds(r, width, height)) return { ok: false, reason: `矩形 ${i} 越界` }
    const cells = rectCells(r, width)
    if (cells.length !== r.w * r.h) return { ok: false, reason: `矩形 ${i} 面积异常` }
    let clues = 0
    let clueValue = 0
    for (const c of cells) {
      if (owner[c] >= 0) return { ok: false, reason: `格子 ${c} 被多个矩形覆盖` }
      owner[c] = i
      if ((givens[c] ?? 0) > 0) {
        clues++
        clueValue = givens[c]!
      }
    }
    if (clues !== 1) return { ok: false, reason: `矩形 ${i} 含 ${clues} 个数字` }
    if (clueValue !== r.w * r.h) {
      return { ok: false, reason: `矩形 ${i} 面积 ${r.w * r.h} ≠ 数字 ${clueValue}` }
    }
  }
  for (let c = 0; c < size; c++) {
    if (owner[c] < 0) return { ok: false, reason: `格子 ${c} 未被覆盖` }
  }
  return { ok: true }
}

/** 检查题面本身是否可能可解：每个数字都至少有一个候选矩形 */
export function puzzleHasCandidates(puzzle: Puzzle): boolean {
  const p: ShikakuPuzzle = asShikakuPuzzle(puzzle)
  const { clueCands } = buildCandidates(p)
  const size = p.width * p.height
  for (let i = 0; i < size; i++) {
    if (clueAt(p, i) > 0 && clueCands[i]!.length === 0) return false
  }
  return clueCountOf(p.givens) > 0
}
