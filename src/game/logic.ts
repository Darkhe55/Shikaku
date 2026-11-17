/**
 * 数方 —— 逻辑解题（规则推理 + 反证），产出 LogicPlan / PlaybackFrame 回放
 *
 * 推理规则（每一步都只放「必然存在」的矩形，因此回放顺序即证明顺序）：
 *   R1 数字格唯一候选   某个数字只剩一个候选矩形 → 必然放它；
 *   R2 覆盖传播         某个未覆盖格只剩一个能覆盖它的候选矩形 → 必然放它；
 *   R3 候选排除         隐藏单值：某格只能由同一数字覆盖 / 某数字的所有候选都含同一格，
 *                       据此排除不兼容的候选（只缩候选集，不产生回放帧）；
 *   R4 反证             假设某候选矩形成立后，R1–R3 立刻推出矛盾 → 排除它（不产生帧）；
 *   R5 回溯补完         规则推不满（例如用户自制的难题）时用回溯求解补完并标注「回溯试探」。
 */

import type { GameState, LogicPlan, PlaybackFrame, Puzzle } from '../core/types'
import {
  buildCandidates,
  findSolution,
  propagateCandidates,
  type CandidateIndex,
  type CandidateOps,
} from './solver.ts'
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
  search: { rule: 5, label: '回溯试探：完成剩余部分' },
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

  const stats: Record<string, number> = {
    probes: 0,
    eliminated: 0,
    hiddenKills: 0,
    searchNodes: 0,
    propagations: 0,
  }
  const bail = (): LogicPlan => ({ ...EMPTY_PLAN(p.id), stats })

  const index: CandidateIndex = buildCandidates(p)
  const { candidates, cellCands, clueCands } = index
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

  for (const r of s.rects) {
    if (!r) continue
    if (r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) return bail()
    let clues = 0
    let clueValue = 0
    for (const c of rectCells(r, w)) {
      if (covered[c]) return bail() // 已有矩形互相重叠，无法推理
      covered[c] = 1
      if (clueAt(p, c) > 0) {
        clues++
        clueValue = clueAt(p, c)
      }
    }
    if (clues !== 1 || clueValue !== r.w * r.h) return bail()
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

  /** 放一个候选：覆盖格子 + 杀掉所有相交候选 */
  const placeCand = (
    aliveArr: Uint8Array,
    coveredArr: Uint8Array,
    candId: number,
  ): void => {
    const cand = candidates[candId]!
    for (const c of cand.cells) coveredArr[c] = 1
    for (const c of cand.cells) {
      for (const other of cellCands[c]!) {
        if (aliveArr[other]) aliveArr[other] = 0
      }
    }
  }

  /** 规则 1–3 的确定性传播；onPlace 用来记录回放帧 */
  const propagate = (
    aliveArr: Uint8Array,
    coveredArr: Uint8Array,
    onPlace: (candId: number, kind: RuleKind) => void,
    countStats = true,
  ): boolean => {
    const ops: CandidateOps = {
      place: (candId, kind) => {
        placeCand(aliveArr, coveredArr, candId)
        if (countStats) stats.propagations++
        onPlace(candId, kind === 'cell' ? 'uniqueCell' : 'uniqueClue')
      },
      kill: (candId) => {
        if (!aliveArr[candId]) return
        aliveArr[candId] = 0
        if (countStats) stats.hiddenKills++
      },
    }
    return propagateCandidates(p, index, aliveArr, coveredArr, ops)
  }

  const allCovered = (coveredArr: Uint8Array): boolean => {
    for (let i = 0; i < size; i++) if (!coveredArr[i]) return false
    return true
  }

  /* —— 3. 推理主循环 —— */

  let saturated = false
  for (let round = 0; round < size + 8; round++) {
    const before = frames.length
    if (
      !propagate(
        alive,
        covered,
        (cid, rule) => emit(rule, candidates[cid]!.rect),
      )
    ) {
      contradiction = true
      break
    }
    if (allCovered(covered)) {
      saturated = true
      break
    }

    // 规则 4：反证 —— 优先试「剩余候选最少」的数字，逐候选整盘传播
    let progressed = frames.length > before
    let probeBudgetLeft = probeBudget
    const cluesByCount: Array<{ clue: number; count: number }> = []
    for (let clue = 0; clue < size; clue++) {
      if (clueAt(p, clue) <= 0 || covered[clue]) continue
      let count = 0
      for (const cid of clueCands[clue]!) if (alive[cid]) count++
      if (count > 1) cluesByCount.push({ clue, count })
    }
    cluesByCount.sort((a, b) => a.count - b.count)

    for (const { clue } of cluesByCount) {
      if (probeBudgetLeft <= 0) break
      for (const cid of clueCands[clue]!) {
        if (!alive[cid]) continue
        if (probeBudgetLeft-- <= 0) break
        stats.probes++
        const trialAlive = alive.slice()
        const trialCovered = covered.slice()
        placeCand(trialAlive, trialCovered, cid)
        if (
          !propagate(
            trialAlive,
            trialCovered,
            () => {
              /* 试探分支不产生回放帧 */
            },
            false,
          )
        ) {
          alive[cid] = 0
          eliminated++
          stats.eliminated++
          progressed = true
        }
      }
    }
    probeBudget = probeBudgetLeft

    if (!progressed) break
  }

  /* —— 4. 推不满时用回溯补完，保证「逻辑解题」最终能给出完整盘面 —— */

  if (!contradiction && !allCovered(covered)) {
    const found = findSolution(p, 600_000)
    stats.searchNodes = found.nodes
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
    ruleSteps: frames.length + eliminated + stats.hiddenKills,
    saturated,
    stats,
  }
}

export { existingRectsForTests }

/** 调试辅助：收集盘面里已有的矩形（仅测试/审计使用） */
function existingRectsForTests(state: GameState): Rect[] {
  const out: Rect[] = []
  for (const r of asShikakuState(state).rects) if (r) out.push(r)
  return out
}
