/**
 * 数方 —— 候选矩形枚举 + 覆盖传播 + 回溯求解
 *
 * 核心事实：每个格子的归属只有一种可能——它所在的矩形必须包含某个数字，
 * 面积等于那个数字。所以我们先为每个数字枚举出「面积 = 数字、只含这一个数字」
 * 的所有候选矩形；求解就是从某个未覆盖格子出发，尝试覆盖它的候选矩形。
 *
 * 候选传播（都是可证明的局部推理，不猜）：
 *   R1 数字格唯一候选     某个数字只剩一个候选矩形 → 它必在解中；
 *   R2 覆盖传播           某个未覆盖格只剩一种候选矩形能覆盖 → 它必在解中；
 *   R3 候选排除（隐藏单值）两条等价约束：
 *        a) 某未覆盖格的所有候选都属于同一个数字 → 该数字必须覆盖这一格，
 *           于是这个数字「不含这一格」的候选全被排除；
 *        b) 某数字的全部候选都覆盖同一格 → 别的数字不能再用这一格，
 *           于是别的数字「含这一格」的候选全被排除。
 *
 * 剪枝：
 *   - 候选矩形面积固定，天然满足面积约束；
 *   - 一旦放下矩形，所有与它相交的候选矩形立即失效；
 *   - 搜索前先做候选传播，再按 MRV（剩余候选最少的未覆盖格 / 数字）分支。
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
          clueCands[cell]!.push(id)
          for (const c of cells) cellCands[c]!.push(id)
        }
      }
    }
  }

  return { candidates, cellCands, clueCands }
}

/* ────────────────────────── 候选传播 ────────────────────────── */

/** 传播时对候选集的操作（由调用方维护「已放矩形 / 失效候选」的账本） */
export interface CandidateOps {
  /** 放下一个候选矩形（kind 标明命中的是 R1 还是 R2） */
  place(candId: number, kind?: 'clue' | 'cell'): void
  /** 排除一个候选矩形（不放下） */
  kill(candId: number): void
}

/**
 * 候选传播：在 alive / covered 上反复执行 R1–R3，直到不动点。
 * @returns false 表示推出矛盾
 */
export function propagateCandidates(
  p: ShikakuPuzzle,
  index: CandidateIndex,
  alive: Uint8Array,
  covered: Uint8Array,
  ops: CandidateOps,
): boolean {
  const { candidates, cellCands, clueCands } = index
  const w = p.width
  const size = w * p.height
  const covers = (candId: number, cell: number): boolean =>
    candidates[candId]!.cells.indexOf(cell) >= 0

  let changed = true
  while (changed) {
    changed = false

    // R1：每个未覆盖数字只剩一个候选矩形
    for (let clue = 0; clue < size; clue++) {
      if (clueAt(p, clue) <= 0 || covered[clue]) continue
      let found = -1
      let count = 0
      for (const cid of clueCands[clue]!) {
        if (!alive[cid]) continue
        count++
        found = cid
        if (count > 1) break
      }
      if (count === 0) return false
      if (count === 1) {
        ops.place(found, 'clue')
        changed = true
      }
    }

    // R2：每个未覆盖格只剩一个能覆盖它的候选矩形
    for (let cell = 0; cell < size; cell++) {
      if (covered[cell]) continue
      let found = -1
      let count = 0
      for (const cid of cellCands[cell]!) {
        if (!alive[cid]) continue
        count++
        found = cid
        if (count > 1) break
      }
      if (count === 0) return false
      if (count === 1) {
        ops.place(found, 'cell')
        changed = true
      }
    }

    // R3a：某未覆盖格只能由同一个数字的候选覆盖 → 该数字的矩形必须覆盖它
    for (let cell = 0; cell < size; cell++) {
      if (covered[cell]) continue
      let clue = -1
      let multiple = false
      let any = false
      for (const cid of cellCands[cell]!) {
        if (!alive[cid]) continue
        any = true
        const c = candidates[cid]!.clue
        if (clue < 0) clue = c
        else if (clue !== c) {
          multiple = true
          break
        }
      }
      if (!any) return false
      if (multiple || clue < 0) continue
      for (const cid of clueCands[clue]!) {
        if (!alive[cid] || covers(cid, cell)) continue
        ops.kill(cid)
        changed = true
      }
    }

    // R3b：某数字的全部候选都覆盖同一格 → 别的数字不能再用这一格
    for (let clue = 0; clue < size; clue++) {
      if (clueAt(p, clue) <= 0 || covered[clue]) continue
      const ids: number[] = []
      for (const cid of clueCands[clue]!) if (alive[cid]) ids.push(cid)
      if (ids.length <= 1) continue
      let common = candidates[ids[0]!]!.cells.slice()
      for (let q = 1; q < ids.length && common.length; q++) {
        const cells = candidates[ids[q]!]!.cells
        common = common.filter((c) => cells.indexOf(c) >= 0)
      }
      for (const cell of common) {
        if (covered[cell]) return false // 该数字必须覆盖这一格，但它已被别的矩形占用
        for (const cid of cellCands[cell]!) {
          if (!alive[cid]) continue
          if (candidates[cid]!.clue === clue) continue
          ops.kill(cid)
          changed = true
        }
      }
    }
  }

  return true
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
  /** 候选传播放下的矩形次数（诊断） */
  propagations: number
  /** 候选排除次数（诊断） */
  killed: number
}

type TrailOp =
  | { placed: number; killed: number[] }
  | { killed: number[]; placed?: undefined }

/**
 * 用候选矩形做精确覆盖搜索。
 * 每个节点先做候选传播（R1–R3），再对「候选最少的未覆盖格 / 数字」分支。
 */
export function searchSolutions(puzzle: Puzzle, options: SearchOptions): SearchOutcome {
  const p = asShikakuPuzzle(puzzle)
  const w = p.width
  const h = p.height
  const size = w * h
  const index = buildCandidates(p)
  const { candidates, cellCands, clueCands } = index

  const solutions: Rect[][] = []
  const placed: number[] = []
  const covered = new Uint8Array(size)
  const alive = new Uint8Array(candidates.length).fill(1)
  const trail: TrailOp[] = []
  let nodes = 0
  let timedOut = false
  let propagations = 0
  let killed = 0

  /** 放下一个候选：覆盖格子，并杀掉所有与它相交的候选 */
  const place = (candId: number, _kind?: 'clue' | 'cell'): void => {
    const cand = candidates[candId]!
    for (const c of cand.cells) covered[c] = 1
    const removed: number[] = []
    for (const c of cand.cells) {
      for (const other of cellCands[c]!) {
        if (alive[other]) {
          alive[other] = 0
          removed.push(other)
        }
      }
    }
    placed.push(candId)
    trail.push({ placed: candId, killed: removed })
    propagations++
  }

  const kill = (candId: number): void => {
    if (!alive[candId]) return
    alive[candId] = 0
    trail.push({ killed: [candId] })
    killed++
  }

  const undoTo = (mark: number): void => {
    while (trail.length > mark) {
      const op = trail.pop()!
      if (op.placed !== undefined) {
        const cand = candidates[op.placed]!
        for (const c of cand.cells) covered[c] = 0
        placed.pop()
      }
      for (const id of op.killed) alive[id] = 1
    }
  }

  const propagate = (): boolean => propagateCandidates(p, index, alive, covered, { place, kill })

  const dfs = (): void => {
    if (timedOut || solutions.length >= options.limit) return
    nodes++
    if (nodes > options.maxNodes) {
      timedOut = true
      return
    }
    if (!propagate()) return

    // MRV：在未覆盖格与未覆盖数字里挑「可用候选最少」的一条分支
    let bestCell = -1
    let bestCellCount = Number.POSITIVE_INFINITY
    for (let cell = 0; cell < size; cell++) {
      if (covered[cell]) continue
      let count = 0
      for (const cid of cellCands[cell]!) {
        if (!alive[cid]) continue
        count++
        if (count >= bestCellCount) break
      }
      if (count === 0) return
      if (count < bestCellCount) {
        bestCellCount = count
        bestCell = cell
      }
    }
    if (bestCell < 0) {
      solutions.push(placed.map((id) => ({ ...candidates[id]!.rect })))
      return
    }

    let bestClue = -1
    let bestClueCount = Number.POSITIVE_INFINITY
    for (let clue = 0; clue < size; clue++) {
      if (clueAt(p, clue) <= 0 || covered[clue]) continue
      let count = 0
      for (const cid of clueCands[clue]!) {
        if (!alive[cid]) continue
        count++
        if (count >= bestClueCount) break
      }
      if (count === 0) return
      if (count < bestClueCount) {
        bestClueCount = count
        bestClue = clue
      }
    }

    const useClue = bestClue >= 0 && bestClueCount < bestCellCount
    const list: number[] = []
    for (const cid of useClue ? clueCands[bestClue]! : cellCands[bestCell]!) {
      if (alive[cid]) list.push(cid)
    }
    if (!list.length) return

    const mark = trail.length
    for (const candId of list) {
      if (timedOut || solutions.length >= options.limit) return
      place(candId)
      dfs()
      undoTo(mark)
    }
  }

  dfs()
  return { solutions, nodes, timedOut, propagations, killed }
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
