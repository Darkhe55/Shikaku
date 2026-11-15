/**
 * ════════════════════════════════════════════════════════════════════
 *  数方（Shikaku）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 规则：
 *   1. 把整个棋盘划分成若干矩形；
 *   2. 每个矩形恰好包含一个数字，且面积（格数）等于该数字；
 *   3. 每个格子恰好属于一个矩形，数字格不能被多个矩形共用。
 *
 * 状态 = 矩形槽位数组（rects），Move 用 (index=矩形 id, from/to=几何编码) 表达，
 * 因此撤销/重做/逻辑回放都复用模板的同一套机制。
 */

import { playDrop, playPluck } from '../core/audio'
import type {
  BoardMetrics,
  CustomSupport,
  GameAdapter,
  Move,
  Puzzle,
  SolveResult,
} from '../core/types'
import { interaction } from './interaction'
import { planLogicSolve } from './logic'
import { builtinPuzzles, getReferenceSolution } from './puzzles'
import { flashRect, hitTest, metricsFor, renderBoard } from './render'
import { countSolutions, solvePuzzle as solve } from './solver'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state'
import { statusBits, validate } from './validate'
import {
  asShikakuPuzzle,
  clueCountOf,
  decodeClues,
  decodeRectCode,
  encodeClues,
  type ShikakuPuzzle,
} from './types'

const meta = {
  title: '数方 Shikaku',
  tagline: '把棋盘切成矩形，每个数字的格数就是它所在矩形的面积 —— 经典 Shikaku',
  footerNote:
    '规则：把整个矩形棋盘划分成若干小矩形，每个小矩形恰好包含一个数字，且面积（格数）等于该数字；每个格子恰好属于一个矩形，数字格不能被多个矩形共用。',
  storageKeyPrefix: 'shikaku',
  customIdPrefix: 'shikaku-custom-',
  customMinW: 3,
  customMinH: 3,
  customMaxW: 20,
  customMaxH: 20,
  targetKind: 'cell' as const,
  interactionHint: '<kbd>左键拖拽</kbd> 画矩形 · <kbd>右键</kbd> 删除 · <kbd>单击</kbd> 选中/取消',
  legendLines: [
    '<kbd>左键拖拽</kbd> 从矩形一角拖到对角画矩形 · <kbd>右键</kbd> 删除矩形',
    '<kbd>单击矩形</kbd> 取消它 · <kbd>单击数字格</kbd> 选中，再拖拽或按 <kbd>Enter</kbd> 画矩形',
    '<kbd>方向键</kbd> 移动选中格 · <kbd>Enter</kbd> 开始/结束矩形 · <kbd>Esc</kbd> 取消 · <kbd>Delete</kbd> 删除',
    '<kbd>滚轮</kbd> 缩放 · <kbd>中键拖拽</kbd> 平移 · <kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> 缩放复位',
    '<kbd>Z</kbd>/<kbd>Shift+Z</kbd> 撤销/重做 · <kbd>C</kbd> 检查 · <kbd>L</kbd> 逻辑解题 · <kbd>P</kbd> 暂停回放 · <kbd>R</kbd> 随机 · <kbd>M</kbd> 音效',
  ],
}

/* ────────────────────────── 自定义题板 ────────────────────────── */

const MAX_CUSTOM_VALUE = 20

const VALUE_CYCLE: Array<number | null> = [
  null,
  ...Array.from({ length: MAX_CUSTOM_VALUE }, (_, i) => i + 1),
]

function readGivens(value: unknown, size: number): number[] | null {
  if (typeof value === 'string') {
    const decoded = decodeClues(value, size)
    if (!decoded) return null
    for (const v of decoded) if (v > MAX_CUSTOM_VALUE) return null
    return decoded
  }
  if (Array.isArray(value)) {
    if (value.length !== size) return null
    const out: number[] = []
    for (const raw of value) {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0 || n > MAX_CUSTOM_VALUE) return null
      out.push(n)
    }
    return out
  }
  return null
}

const custom: CustomSupport = {
  mode: 'cell',
  valueCycle: VALUE_CYCLE,
  maxValue: MAX_CUSTOM_VALUE,

  keyForDigit: (digit) => (digit === 0 ? null : digit),

  cellLabel: (v) => (v == null ? '' : String(v)),

  hint:
    '点击格子循环 空→1…20；键盘直接按 1–9，0.7 秒内继续按数字可输入 10–20（如 1、2 → 12）；方向键移动、. / 退格清空。保存时会自动检查是否恰好一解。',

  toGrid: (p) => {
    const sp = asShikakuPuzzle(p)
    if (!Array.isArray(sp.givens) || sp.givens.length !== p.width * p.height) return null
    return {
      width: p.width,
      height: p.height,
      grid: sp.givens.map((v) => (v > 0 ? v : null)),
    }
  },

  makePuzzle: (w, h, grid, existingId) => {
    const givens = grid.map((v) =>
      typeof v === 'number' && v >= 1 && v <= MAX_CUSTOM_VALUE ? Math.floor(v) : 0,
    )
    return {
      id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
      name: `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      givens,
    } satisfies ShikakuPuzzle
  },

  validatePuzzle: (p) => {
    const sp = asShikakuPuzzle(p)
    const size = p.width * p.height
    if (!Array.isArray(sp.givens) || sp.givens.length !== size) {
      return { ok: false, message: '题面数据不完整。', tone: 'bad' }
    }
    if (clueCountOf(sp.givens) === 0) {
      return { ok: false, message: '题面没有任何数字，无法作为数方题目。', tone: 'bad' }
    }
    const counted = countSolutions(p, 2, 400_000)
    if (counted.timedOut) {
      return { ok: true, message: '（唯一解检查超时，暂按可用题处理）', tone: 'ok' }
    }
    if (counted.count === 0) {
      return {
        ok: false,
        message: '题面无解：有格子无法被合法矩形覆盖，或数字之间自相矛盾。',
        tone: 'bad',
      }
    }
    if (counted.count > 1) {
      return {
        ok: true,
        message: '⚠ 解不唯一（至少 2 组解）：仍可保存，但题目可能有歧义。',
        tone: 'ok',
      }
    }
    return { ok: true, message: '唯一解 ✓', tone: 'ok' }
  },

  encodePuzzle: (p) => ({
    givens: encodeClues(asShikakuPuzzle(p).givens ?? []),
  }),

  decodePuzzle: (record) => {
    if (typeof record.id !== 'string') return null
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const w = record.width
    const h = record.height
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
    if (w > meta.customMaxW || h > meta.customMaxH) return null
    const givens = readGivens(record.givens, w * h)
    if (!givens) return null
    return {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      givens,
    } satisfies ShikakuPuzzle
  },
}

/* ────────────────────────── 音效 / 特效 ────────────────────────── */

function playForMove(move: Move, streak: number): void {
  if (move.from === 0) {
    // 新建矩形：像拨弦；面积越大音越低
    playPluck(streak, 1)
  } else {
    playDrop(streak)
  }
}

function flashForMove(
  svg: SVGSVGElement,
  move: Move,
  streak: number,
  m: BoardMetrics,
): void {
  const adding = move.from === 0
  const code = adding ? move.to : move.from
  const rect = decodeRectCode(code, m.width, m.height)
  if (!rect) return
  flashRect(svg, m, rect, adding ? 'add' : 'remove', streak)
}

/* ────────────────────────── 组装 ────────────────────────── */

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solve(puzzle, maxNodes),
  firstHintMove,
  custom,
  interaction,
  playForMove,
  flashForMove,
}
