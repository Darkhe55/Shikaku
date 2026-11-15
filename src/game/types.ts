/**
 * 数方（Shikaku）—— 游戏专用类型与编码
 *
 * 规则：
 *   1. 把整个矩形棋盘划分成若干个小矩形；
 *   2. 每个小矩形恰好包含一个数字，且面积（格数）等于该数字；
 *   3. 每个格子恰好属于一个小矩形，数字格不能被多个矩形共用。
 *
 * 数据表示：
 *   - 题面 Puzzle：givens 每格一个数字（0 = 没有数字），参考解 solution 是矩形列表；
 *   - 盘面 State：rects 是「矩形槽位」数组，槽位下标就是矩形 id，null = 已删除。
 *     用槽位而不是单纯矩形列表，是为了让 Move(index=id, from/to=编码) 可逆：
 *       from = 0 → 新建矩形（to 是矩形几何编码）
 *       to   = 0 → 删除矩形（from 是矩形几何编码）
 *     撤销就是把 from/to 对调，天然支持撤销/重做。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'

/** 一个矩形：左上角 (x,y)，宽 w 高 h（单位：格） */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 数方题面：givens 每格一个数字，0 表示没有数字 */
export interface ShikakuPuzzle extends Puzzle {
  givens: number[]
  /** 参考解（仅内置题携带，按矩形列表保存） */
  solution?: Rect[]
}

/** 数方盘面：rects 为矩形槽位数组，下标 = 矩形 id */
export interface ShikakuState extends GameState {
  rects: Array<Rect | null>
  /** 下一个可用的矩形 id（保证新建矩形 id 不与历史 id 冲突） */
  nextId: number
}

export type RectIssueKind = 'area' | 'noClue' | 'multiClue' | 'overlap' | 'outside'

/** 单个矩形的错误明细 */
export interface RectIssue {
  rectId: number
  kind: RectIssueKind
  /** 该矩形覆盖的格子（越界矩形只统计盘内格子） */
  cells: number[]
  area: number
  clueCount: number
}

/** 校验结果 */
export interface ShikakuResult extends ValidationResult {
  /** 仍未覆盖的格数 */
  empty: number
  /** 已覆盖的格数（含重叠重复计数前的格子数） */
  covered: number
  total: number
  complete: boolean
  rectCount: number
  rectIssues: RectIssue[]
  /** 需要高亮的错误格 */
  badCells: number[]
  /** 被多个矩形覆盖的格子 */
  overlapCells: number[]
  /** 没有被任何矩形覆盖的数字格（数字未使用） */
  uncoveredClues: number[]
  /** 几何越界的矩形 id */
  outsideRects: number[]
}

export function asShikakuPuzzle(p: Puzzle): ShikakuPuzzle {
  return p as ShikakuPuzzle
}

export function asShikakuState(s: GameState): ShikakuState {
  return s as ShikakuState
}

export function clueAt(p: ShikakuPuzzle, index: number): number {
  const v = p.givens[index] ?? 0
  return v > 0 ? v : 0
}

export function clueCountOf(givens: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < givens.length; i++) if ((givens[i] ?? 0) > 0) n++
  return n
}

/* ────────────────────────── 矩形几何 ────────────────────────── */

export function rectCells(rect: Rect, width: number): number[] {
  const out: number[] = []
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) out.push(y * width + x)
  }
  return out
}

export function rectArea(rect: Rect): number {
  return rect.w * rect.h
}

export function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

export function inBounds(rect: Rect, width: number, height: number): boolean {
  return (
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.w) &&
    Number.isInteger(rect.h) &&
    rect.w >= 1 &&
    rect.h >= 1 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= width &&
    rect.y + rect.h <= height
  )
}

/* ────────────────────────── Move 编码 ────────────────────────── */

/**
 * 把矩形几何编码进 Move.from / Move.to（0 保留给「空」）。
 * 打包方式：((y*width + x) << 12) | (h << 6) | w，再 +1。
 * 支持 width/height ≤ 40、w/h ≤ 63，足够覆盖自定义题板的 20×20 上限。
 */
export function rectCode(rect: Rect, width: number): number {
  return 1 + (((rect.y * width + rect.x) << 12) | (rect.h << 6) | rect.w)
}

export function decodeRectCode(code: number, width: number, height: number): Rect | null {
  if (!Number.isInteger(code) || code <= 0) return null
  const raw = code - 1
  const w = raw & 63
  const h = (raw >> 6) & 63
  const pos = raw >> 12
  if (w < 1 || h < 1) return null
  const x = pos % width
  const y = Math.floor(pos / width)
  const rect = { x, y, w, h }
  return inBounds(rect, width, height) ? rect : null
}

/* ────────────────────────── 题面编码 ────────────────────────── */

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 每格一个 base36 字符；0 = 无数字，1–35 = 数字 */
export function encodeClues(givens: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < givens.length; i++) {
    const v = givens[i]! | 0
    if (v <= 0 || v >= BASE36.length) out += '0'
    else out += BASE36[v]!
  }
  return out
}

export function decodeClues(text: unknown, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected).fill(0)
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!.toLowerCase()
    if (ch === '.' || ch === '-' || ch === '?') continue
    const v = BASE36.indexOf(ch)
    if (v < 0) return null
    out[i] = v
  }
  return out
}

/**
 * 矩形列表编码：`x,y,w,h;x,y,w,h;...`，空槽位写 `-`。
 * 空槽位保留是为了撤销/重做时矩形 id 稳定。
 */
export function encodeRects(rects: Array<Rect | null>): string {
  return rects
    .map((r) => (r ? `${r.x},${r.y},${r.w},${r.h}` : '-'))
    .join(';')
}

export function decodeRects(
  text: unknown,
  width: number,
  height: number,
): Array<Rect | null> | null {
  if (typeof text !== 'string') return null
  if (text === '') return []
  const parts = text.split(';')
  const out: Array<Rect | null> = []
  for (const part of parts) {
    const s = part.trim()
    if (s === '' || s === '-') {
      out.push(null)
      continue
    }
    const nums = s.split(',').map((n) => Number(n))
    if (nums.length !== 4) return null
    const rect = { x: nums[0]!, y: nums[1]!, w: nums[2]!, h: nums[3]! }
    if (!inBounds(rect, width, height)) return null
    out.push(rect)
  }
  return out
}

/** 去掉尾部空槽位（序列化前压缩，避免存档里一堆 '-'） */
export function trimRects(rects: Array<Rect | null>): Array<Rect | null> {
  let end = rects.length
  while (end > 0 && rects[end - 1] === null) end--
  return rects.slice(0, end)
}

/** 计算合法的 nextId：必须大于所有现存槽位下标 */
export function normalizeNextId(rects: Array<Rect | null>, nextId: unknown): number {
  let next = typeof nextId === 'number' && Number.isFinite(nextId) ? Math.floor(nextId) : 0
  if (next < 0) next = 0
  if (next < rects.length) next = rects.length
  // 槽位里可能留着比 next 更大 id 的记录（旧存档），取最大下标 + 1
  for (let i = rects.length - 1; i >= 0; i--) {
    if (rects[i]) {
      if (next < i + 1) next = i + 1
      break
    }
  }
  return next
}
