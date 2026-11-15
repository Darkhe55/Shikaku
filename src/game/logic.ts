/**
 * 数方 —— 逻辑解题（规则推理 + 反证），产出 LogicPlan / PlaybackFrame 回放
 *
 * 推理规则（每一步都只放「必然存在」的矩形，因此回放顺序即证明顺序）：
 *   1. 数字格面积约束：某个数字只剩一个候选矩形 → 必然放它；
 *   2. 覆盖传播：某个未覆盖格子只剩一个能覆盖它的候选矩形 → 必然放它；
 *   3. 反证：假设某候选矩形成立后，规则 1/2 立刻推出矛盾 → 排除它（不产生帧）；
 *   4. 若规则推不满（例如用户自制的难题），用回溯求解补完，并标注「回溯试探」。
 */

import type { GameState, LogicPlan, PlaybackFrame, Puzzle } from '../core/types'
import { buildCandidates, findSolution } from './solver.ts'
import { applyMove, cloneState } from './state.ts'
import {
  asShikakuPuzzle,
  asShikakuState,
  clueAt,
  rectCells,
  rectCode,
  sameRect,
  type Rect,
} from './types.ts'

type RuleKind = 'uniqueClue' | 'uniqueCell' | 'search'

const RULE_INFO: Record<RuleKind, { rule: number; label: string }> = {
  uniqueClue: { rule: 1, label: '数字格只剩一个候选矩形 → 必然放下' },
  uniqueCell: { rule: 2, label: '覆盖传播：这一格只剩一种矩形可选' },
  search: { rule: 4, label: '回溯试探：完成剩余部分' },
}

const EMPTY_PLAN = (puzzleId: string): LogicPlan => ({
  puzzleId,
  frames: [],
  finalState: null,
  ruleSteps: 0,
  saturated: false,
})

/** 反证预算：候选太多时只做有限次探测，避免卡住界面 */
const PROBE_BUDGET = 6_000

export function planLogicSolve(puzzle: Puzzle, initialState: GameState): LogicPlan {
  const p = asShikakuPuzzle(puzzle)
  const s = asShikakuState(initialState)
  const w = p.width
  const h = p.height
  const size = w * h
  if (!Array.isArray(p.givens) || p.givens.length !== size) return EMPTY_PLAN(p.id)

  const { candidates, cellCands, clueCands } = buildCandidates(p)
  const alive = new Uint8Array(candidates.length).fill(1)
  const covered = new Uint8Array(size)
  const frames: PlaybackFrame[] = []
  const placedRects: Rect[] = []
  let nextId = Math.max(s.nextId, s.rects.length)
  let lastKind: RuleKind | '' = ''
  let streak = 0
  let eliminated = 0
  let contradiction = false
  let probeBudget = PROBE_BUDGET

  /* —— 1. 把盘面上已有的矩形当作固定条件 —— */

  const existing: Rect[] = []
  for (const r of s.rects) {
    if (!r) continue
    if (r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) return EMPTY_PLAN(p.id)
    let clues = 0
    let clueValue = 0
    for (const c of rectCells(r, w)) {
      if (covered[c]) return EMPTY_PLAN(p.id) // 已有矩形互相重叠，无法推理
      covered[c] = 1
      if (clueAt(p, c) > 0) {
        clues++
        clueValue = clueAt(p, c)
      }
    }
    if (clues !== 1 || clueValue !== r.w * r.h) return EMPTY_PLAN(p.id)
    existing.push(r)
    placedRects.push(r)
  }

  // 与已有矩形相交的候选全部失效
  for (let id = 0; id < candidates.length; id++) {
    const cand = candidates[id]!
    for (const c of cand.cells) {
      if (covered[c]) {
        alive[id] = 0
        break
      }
    }
  }

  /* —— 2. 基础操作 —— */

  const emit = (kind: RuleKind, rect: Rect): void => {
    const id = nextId++
    const move = { index: id, from: 0, to: rectCode(rect, w) }
    if (kind === lastKind) streak++
    else {
      lastKind = kind
      streak = 1
    }
    frames.push({
      rule: RULE_INFO[kind].rule,
      label: RULE_INFO[kind].label,
      move,
      streak,
    })
    placedRects.push(rect)
  }

  /** 放一个候选：覆盖格子 + 杀掉所有相交候选（probe 也用同一套逻辑） */
  const placeCand = (aliveArr: Uint8Array, coveredArr: Uint8Array, candId: number): void => {
    const cand = candidates[candId]!
    for (const c of cand.cells) coveredArr[c] = 1
    for (const c of cand.cells) {
      for (const other of cellCands[c]!) {
        if (aliveArr[other]) aliveArr[other] = 0
      }
    }
  }

  /**
   * 规则 1 / 2 的确定性传播。
   * @param onPlace 首次传播时用来记录回放帧
   * @returns false 表示推出矛盾
   */
  const propagate = (
    aliveArr: Uint8Array,
    coveredArr: Uint8Array,
    onPlace?: (candId: number, rule: RuleKind) => void,
  ): boolean => {
    let changed = true
    while (changed) {
      changed = false

      // 规则 1：每个数字格只剩一个候选矩形
      for (let clue = 0; clue < size; clue++) {
        if (clueAt(p, clue) <= 0) continue
        if (coveredArr[clue]) continue
        let found = -1
        let count = 0
        for (const cid of clueCands[clue]!) {
          if (!aliveArr[cid]) continue
          count++
          found = cid
          if (count > 1) break
        }
        if (count === 0) return false
        if (count === 1) {
          placeCand(aliveArr, coveredArr, found)
          onPlace?.(found, 'uniqueClue')
          changed = true
        }
      }

      // 规则 2：每个未覆盖格子只剩一个候选矩形
      for (let cell = 0; cell < size; cell++) {
        if (coveredArr[cell]) continue
        let found = -1
        let count = 0
        for (const cid of cellCands[cell]!) {
          if (!aliveArr[cid]) continue
          count++
          found = cid
          if (count > 1) break
        }
        if (count === 0) return false
        if (count === 1) {
          placeCand(aliveArr, coveredArr, found)
          onPlace?.(found, 'uniqueCell')
          changed = true
        }
      }
    }
    return true
  }

  const allCovered = (coveredArr: Uint8Array): boolean => {
    for (let i = 0; i < size; i++) if (!coveredArr[i]) return false
    return true
  }

  /* —— 3. 推理主循环 —— */

  let saturated = false
  for (let round = 0; round < size + 8; round++) {
    const before = frames.length
    if (!propagate(alive, covered, (cid, rule) => emit(rule, candidates[cid]!.rect))) {
      contradiction = true
      break
    }
    if (allCovered(covered)) {
      saturated = true
      break
    }

    // 规则 3：反证排除
    let progressed = frames.length > before
    if (probeBudget > 0) {
      for (let clue = 0; clue < size && probeBudget > 0; clue++) {
        if (clueAt(p, clue) <= 0 || covered[clue]) continue
        const list: number[] = []
        for (const cid of clueCands[clue]!) if (alive[cid]) list.push(cid)
        if (list.length <= 1) continue
        for (const cid of list) {
          if (probeBudget-- <= 0) break
          if (!alive[cid]) continue
          const trialAlive = alive.slice()
          const trialCovered = covered.slice()
          placeCand(trialAlive, trialCovered, cid)
          if (!propagate(trialAlive, trialCovered)) {
            alive[cid] = 0
            eliminated++
            progressed = true
          }
        }
      }
    }

    if (!progressed) break
  }

  /* —— 4. 推不满时用回溯补完，保证「逻辑解题」最终能给出完整盘面 —— */

  if (!contradiction && !allCovered(covered)) {
    const found = findSolution(p, 600_000)
    if (found.solution) {
      for (const rect of found.solution) {
        if (placedRects.some((r) => sameRect(r, rect))) continue
        // 已放矩形占用的格子不再覆盖（正常情况不会发生，容错跳过）
        let overlaps = false
        for (const c of rectCells(rect, w)) {
          if (covered[c]) {
            overlaps = true
            break
          }
        }
        if (overlaps) continue
        for (const c of rectCells(rect, w)) covered[c] = 1
        emit('search', rect)
      }
      saturated = false
    }
  }

  const finalState = (() => {
    if (!frames.length) return null
    const state = cloneState(s)
    for (const frame of frames) applyMove(state, frame.move)
    return state
  })()

  return {
    puzzleId: p.id,
    frames,
    finalState,
    ruleSteps: frames.length + eliminated,
    saturated,
  }
}

export { existingRectsForTests }

/** 调试辅助：收集盘面里已有的矩形（仅测试/审计使用） */
function existingRectsForTests(state: GameState): Rect[] {
  const out: Rect[] = []
  for (const r of asShikakuState(state).rects) if (r) out.push(r)
  return out
}
