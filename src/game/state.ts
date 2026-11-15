/**
 * 数方 —— 盘面状态与 Move 应用
 *
 * Move 约定（模板契约里 from/to 的数字枚举，0 一律表示「未定」）：
 *   - 新建矩形：{ index: 矩形 id, from: 0, to: rectCode(rect) }
 *   - 删除矩形：{ index: 矩形 id, from: rectCode(rect), to: 0 }
 * 因此 invertMove 只要交换 from/to 即可撤销。
 */

import type { GameState, HitTarget, Move, Puzzle } from '../core/types'
import {
  asShikakuPuzzle,
  asShikakuState,
  decodeRectCode,
  decodeRects,
  encodeRects,
  inBounds,
  normalizeNextId,
  rectCells,
  rectCode,
  sameRect,
  trimRects,
  type Rect,
  type ShikakuPuzzle,
  type ShikakuState,
} from './types.ts'

/* ────────────────────────── 建盘 / 拷贝 ────────────────────────── */

export function createEmptyState(puzzle: Puzzle): ShikakuState {
  const p = asShikakuPuzzle(puzzle)
  return {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    rects: [],
    nextId: 0,
  }
}

export function cloneState(state: GameState): ShikakuState {
  const s = asShikakuState(state)
  return {
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    rects: s.rects.map((r) => (r ? { ...r } : null)),
    nextId: s.nextId,
  }
}

/** 数方的盘面不由单格点击循环驱动（交互层接管），保留契约实现 */
export function cycleValue(_state: GameState, _target: HitTarget): number {
  return 0
}

export function rightClickValue(_state: GameState, _target: HitTarget): number {
  return 0
}

export function valueAt(state: GameState, index: number): number {
  const s = asShikakuState(state)
  const id = ownerOfCell(s, index)
  return id < 0 ? 0 : id + 1
}

/* ────────────────────────── 几何查询 ────────────────────────── */

/** 覆盖某格的矩形 id（重叠时返回最后写入的一个），没有返回 -1 */
export function ownerOfCell(state: ShikakuState, cell: number): number {
  const w = state.width
  const h = state.height
  if (cell < 0 || cell >= w * h) return -1
  const x = cell % w
  const y = Math.floor(cell / w)
  for (let id = state.rects.length - 1; id >= 0; id--) {
    const r = state.rects[id]
    if (!r) continue
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return id
  }
  return -1
}

/** 覆盖某格的所有矩形 id（用于检测重叠 / 右键一次性清除） */
export function ownersOfCell(state: ShikakuState, cell: number): number[] {
  const w = state.width
  const h = state.height
  const out: number[] = []
  if (cell < 0 || cell >= w * h) return out
  const x = cell % w
  const y = Math.floor(cell / w)
  for (let id = 0; id < state.rects.length; id++) {
    const r = state.rects[id]
    if (!r) continue
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) out.push(id)
  }
  return out
}

/** 当前所有矩形（带 id） */
export function liveRects(state: ShikakuState): Array<{ id: number; rect: Rect }> {
  const out: Array<{ id: number; rect: Rect }> = []
  for (let id = 0; id < state.rects.length; id++) {
    const rect = state.rects[id]
    if (rect) out.push({ id, rect })
  }
  return out
}

/** 当前所有矩形覆盖的格子集合 */
export function coveredCells(state: ShikakuState): Set<number> {
  const out = new Set<number>()
  for (const r of state.rects) {
    if (!r) continue
    for (const cell of rectCells(r, state.width)) out.add(cell)
  }
  return out
}

/** 与给定矩形重叠的矩形 id 列表 */
export function overlappingRectIds(state: ShikakuState, rect: Rect): number[] {
  const out: number[] = []
  for (let id = 0; id < state.rects.length; id++) {
    const r = state.rects[id]
    if (!r) continue
    if (r.x < rect.x + rect.w && rect.x < r.x + r.w && r.y < rect.y + rect.h && rect.y < r.y + r.h) {
      out.push(id)
    }
  }
  return out
}

/* ────────────────────────── Move 构造 / 应用 ────────────────────────── */

export function makeCreateMove(state: ShikakuState, rect: Rect): Move {
  const id = state.nextId
  return { index: id, from: 0, to: rectCode(rect, state.width) }
}

export function makeRemoveMove(state: ShikakuState, rectId: number): Move | null {
  const rect = state.rects[rectId]
  if (!rect) return null
  return { index: rectId, from: rectCode(rect, state.width), to: 0 }
}

export function applyMove(state: GameState, move: Move): void {
  const s = asShikakuState(state)
  const id = move.index
  if (!Number.isInteger(id) || id < 0 || id > 100_000) return
  if (move.to === 0) {
    if (id < s.rects.length) s.rects[id] = null
    return
  }
  const rect = decodeRectCode(move.to, s.width, s.height)
  if (!rect) return
  while (s.rects.length < id) s.rects.push(null)
  s.rects[id] = rect
  if (s.nextId < id + 1) s.nextId = id + 1
}

export function invertMove(move: Move): Move {
  return { index: move.index, from: move.to, to: move.from }
}

/* ────────────────────────── 序列化 ────────────────────────── */

export function serializeState(state: GameState): Record<string, unknown> {
  const s = asShikakuState(state)
  return {
    version: 1,
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    rects: encodeRects(trimRects(s.rects)),
    nextId: s.nextId,
  }
}

export function deserializeState(data: Record<string, unknown>): ShikakuState | null {
  if (typeof data.puzzleId !== 'string') return null
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null
  const w = data.width
  const h = data.height
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null

  let rects: Array<Rect | null>
  if (typeof data.rects === 'string') {
    const decoded = decodeRects(data.rects, w, h)
    if (!decoded) return null
    rects = decoded
  } else if (Array.isArray(data.rects)) {
    rects = []
    for (const item of data.rects) {
      if (item == null) {
        rects.push(null)
        continue
      }
      if (typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const rect = {
        x: Number(o.x),
        y: Number(o.y),
        w: Number(o.w),
        h: Number(o.h),
      }
      if (!inBounds(rect, w, h)) return null
      rects.push(rect)
    }
  } else {
    rects = []
  }

  return {
    puzzleId: data.puzzleId,
    width: w,
    height: h,
    rects,
    nextId: normalizeNextId(rects, data.nextId),
  }
}

/* ────────────────────────── 提示 ────────────────────────── */

function solutionRects(solution: GameState): Rect[] {
  const s = asShikakuState(solution)
  const out: Rect[] = []
  for (const r of s.rects) if (r) out.push({ ...r })
  return out
}

/**
 * 提示一格：优先删除一个「不在参考解里」的矩形，否则补上第一个缺失的参考解矩形。
 */
export function firstHintMove(state: GameState, solution: GameState): Move | null {
  const s = asShikakuState(state)
  const sol = solutionRects(solution)

  for (let id = 0; id < s.rects.length; id++) {
    const rect = s.rects[id]
    if (!rect) continue
    if (!sol.some((x) => sameRect(x, rect))) {
      return makeRemoveMove(s, id)
    }
  }

  for (const target of sol) {
    const exists = s.rects.some((r) => sameRect(r, target))
    if (exists) continue
    const id = s.nextId
    return { index: id, from: 0, to: rectCode(target, s.width) }
  }
  return null
}

/** 从参考解构造盘面（参考解 = 矩形列表） */
export function stateFromRects(
  puzzleId: string,
  width: number,
  height: number,
  rects: Rect[],
): ShikakuState {
  return {
    puzzleId,
    width,
    height,
    rects: rects.map((r) => ({ ...r })),
    nextId: rects.length,
  }
}

/** 供 interaction 判断：给定格子上的数字（从题面取） */
export function clueOfPuzzle(p: Puzzle, cell: number): number {
  const sp: ShikakuPuzzle = asShikakuPuzzle(p)
  return sp.givens[cell] ?? 0
}
