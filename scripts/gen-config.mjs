/**
 * 数方题库生成器（scripts/gen-puzzles.mjs 会调用 generatePuzzles()）
 *
 * 思路：
 *   1. 随机把 w×h 棋盘「贪心」切分成若干矩形（每个矩形面积 ≤ 20）；
 *   2. 每个矩形随机挑一格放上「面积」作为数字 → 由构造保证题目至少有一个解；
 *   3. 唯一解校验：候选矩形回溯计数，必须恰好 1 解；
 *   4. 逻辑可解校验：planLogicSolve 必须只靠规则 1/2/3 推满全盘（saturated=true）；
 *   5. 同一个切分换多个数字位置重试，提高命中率。
 *
 * 结果写成 puzzles-data.ts 里的 board（每格 base36）与 solution（矩形列表）。
 */

import { countSolutions, validateRects } from '../src/game/solver.ts'
import { planLogicSolve } from '../src/game/logic.ts'
import { createEmptyState } from '../src/game/state.ts'
import { encodeClues, encodeRects } from '../src/game/types.ts'

export const NAME = '数方 Shikaku 生成器'

/** 固定种子，保证 `npm run gen` 结果可复现 */
const SEED = 20261115
const MAX_AREA = 20

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 随机切分：从第一个未覆盖格开始，随机挑一个「全部空闲」的矩形填进去 */
function randomPartition(w, h, rng) {
  const size = w * h
  const used = new Uint8Array(size)
  const rects = []
  for (let start = 0; start < size; start++) {
    if (used[start]) continue
    const sx = start % w
    const sy = Math.floor(start / w)
    const options = []
    for (let rw = 1; sx + rw <= w; rw++) {
      for (let rh = 1; sy + rh <= h; rh++) {
        const area = rw * rh
        if (area > MAX_AREA) continue
        let free = true
        for (let y = sy; y < sy + rh && free; y++) {
          for (let x = sx; x < sx + rw; x++) {
            if (used[y * w + x]) {
              free = false
              break
            }
          }
        }
        if (free) options.push({ rw, rh, area })
      }
    }
    if (!options.length) options.push({ rw: 1, rh: 1, area: 1 })
    // 偏好中等面积（3–9），让数字分布更像真实题目
    const weights = options.map((o) => {
      if (o.area === 1) return 0.35
      if (o.area <= 2) return 0.7
      if (o.area <= 9) return 1.6
      return 1
    })
    let total = 0
    for (const x of weights) total += x
    let pick = rng() * total
    let chosen = options[options.length - 1]
    for (let i = 0; i < options.length; i++) {
      pick -= weights[i]
      if (pick <= 0) {
        chosen = options[i]
        break
      }
    }
    for (let y = sy; y < sy + chosen.rh; y++) {
      for (let x = sx; x < sx + chosen.rw; x++) used[y * w + x] = 1
    }
    rects.push({ x: sx, y: sy, w: chosen.rw, h: chosen.rh })
  }
  return rects
}

/** 每个矩形随机挑一格放数字（= 面积） */
function makeGivens(width, height, rects, rng) {
  const givens = new Array(width * height).fill(0)
  for (const r of rects) {
    const cx = r.x + Math.floor(rng() * r.w)
    const cy = r.y + Math.floor(rng() * r.h)
    givens[cy * width + cx] = r.w * r.h
  }
  return givens
}

function makePuzzle(width, height, givens) {
  return { id: 'tmp', name: 'tmp', width, height, difficulty: 'easy', givens }
}

/** 同一题面测试唯一解 + 逻辑可推满 */
function inspect(width, height, givens) {
  const puzzle = makePuzzle(width, height, givens)
  const counted = countSolutions(puzzle, 2, 400_000)
  if (counted.timedOut) return { ok: false, reason: 'timeout' }
  if (counted.count !== 1) return { ok: false, reason: `solutions=${counted.count}` }
  const plan = planLogicSolve(puzzle, createEmptyState(puzzle))
  if (!plan.saturated) return { ok: false, reason: 'logic-stuck' }
  const finalRects = []
  if (plan.finalState) {
    for (const r of plan.finalState.rects) if (r) finalRects.push(r)
  }
  if (!finalRects.length) return { ok: false, reason: 'no-final' }
  const check = validateRects(width, height, givens, finalRects)
  if (!check.ok) return { ok: false, reason: `final:${check.reason}` }
  return { ok: true, nodes: counted.nodes, frames: plan.frames.length }
}

function makeOne(width, height, rng, timeBudgetMs) {
  const started = Date.now()
  for (let attempt = 0; attempt < 4000; attempt++) {
    if (Date.now() - started > timeBudgetMs) return null
    const rects = randomPartition(width, height, rng)
    if (rects.length < 3) continue
    // 同一切分尝试多个数字位置
    for (let clueTry = 0; clueTry < 60; clueTry++) {
      if (Date.now() - started > timeBudgetMs) return null
      const givens = makeGivens(width, height, rects, rng)
      const info = inspect(width, height, givens)
      if (!info.ok) continue
      return { rects, givens, info }
    }
  }
  return null
}

const SIZE_SPECS = [
  { width: 5, height: 5, difficulty: 'easy', series: '入门', count: 2 },
  { width: 6, height: 6, difficulty: 'medium', series: '进阶', count: 1 },
  { width: 7, height: 7, difficulty: 'medium', series: '进阶', count: 1 },
  { width: 8, height: 8, difficulty: 'hard', series: '挑战', count: 1 },
  { width: 9, height: 9, difficulty: 'hard', series: '挑战', count: 1 },
  { width: 10, height: 10, difficulty: 'hard', series: '挑战', count: 1 },
  { width: 12, height: 12, difficulty: 'hard', series: '挑战', count: 1 },
]

export async function generatePuzzles() {
  const rng = mulberry32(SEED)
  const items = []
  let seq = 0
  for (const spec of SIZE_SPECS) {
    let made = 0
    let failures = 0
    while (made < spec.count && failures < 6) {
      const found = makeOne(spec.width, spec.height, rng, spec.width <= 8 ? 25_000 : 50_000)
      seq++
      if (!found) {
        failures++
        console.warn(`[gen] ${spec.width}×${spec.height} 生成未成功，重试（${failures}/6）…`)
        continue
      }
      failures = 0
      made++
      const id = `shikaku-${spec.width}x${spec.height}-${String(seq).padStart(2, '0')}`
      const label = spec.count > 1 ? ` ${made}` : ''
      items.push({
        id,
        name: `数方 · ${spec.width}×${spec.height} · ${spec.series}${label}`,
        width: spec.width,
        height: spec.height,
        difficulty: spec.difficulty,
        series: spec.series,
        board: encodeClues(found.givens),
        solution: encodeRects(found.rects),
      })
      console.log(
        `[gen] ${id} ${spec.width}×${spec.height} · ${found.rects.length} 个矩形 · ` +
          `解唯一 · 逻辑 ${found.info.frames} 帧 / 搜索 ${found.info.nodes} 节点`,
      )
    }
    if (made < spec.count) {
      console.warn(`[gen] 跳过 ${spec.width}×${spec.height}：未能生成满足条件的题目`)
    }
  }
  return items
}
