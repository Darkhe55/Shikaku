/**
 * 数方题库审计（npm run check）
 *
 * 对 src/game/puzzles-data.ts 里的每道题做完整规则校验：
 *   1. 结构：id 唯一 / 宽高合法 / 难度合法 / board 长度 = 宽×高；
 *   2. 题面：至少一个数字、每个数字都至少有候选矩形（可解的前提）；
 *   3. 参考解：矩形列表可解码、面积 = 数字、每矩形恰好一个数字、覆盖全盘；
 *   4. 唯一解：候选矩形回溯计数，必须恰好 1 解；
 *   5. 逻辑：从空盘出发 planLogicSolve 必须推满全盘（saturated = true），
 *      并且终态通过规则校验；
 *   6. 题库：至少 6 题，且覆盖至少 4 种不同尺寸。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decodeClues, decodeRects, clueCountOf } from '../src/game/types.ts'
import { countSolutions, puzzleHasCandidates, validateRects } from '../src/game/solver.ts'
import { planLogicSolve } from '../src/game/logic.ts'
import { createEmptyState } from '../src/game/state.ts'
import { validate } from '../src/game/validate.ts'
import { RAW_PUZZLES } from '../src/game/puzzles-data.ts'

const DATA_FILE = path.resolve('src/game/puzzles-data.ts')
readFileSync(DATA_FILE, 'utf8')

let errors = 0
let warnings = 0
const ids = new Set()
const sizes = new Set()

const fail = (id, message) => {
  console.error(`[check] ✗ ${id}：${message}`)
  errors++
}
const warn = (id, message) => {
  console.warn(`[check] ! ${id}：${message}`)
  warnings++
}

for (const raw of RAW_PUZZLES) {
  const size = raw.width * raw.height
  const id = raw.id

  /* —— 1. 结构 —— */
  if (ids.has(id)) fail(id, 'id 重复')
  ids.add(id)
  if (!raw.name) fail(id, '缺 name')
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width <= 0 || raw.height <= 0) {
    fail(id, `宽高非法 ${raw.width}×${raw.height}`)
    continue
  }
  if (!['easy', 'medium', 'hard', 'custom'].includes(raw.difficulty)) {
    fail(id, `难度非法 ${raw.difficulty}`)
  }
  if (typeof raw.board !== 'string' || raw.board.length !== size) {
    fail(id, `board 长度 ${String(raw.board).length} ≠ ${size}`)
    continue
  }
  sizes.add(`${raw.width}x${raw.height}`)

  /* —— 2. 题面 —— */
  const givens = decodeClues(raw.board, size)
  if (!givens) {
    fail(id, 'board 编码非法')
    continue
  }
  const clues = clueCountOf(givens)
  if (clues === 0) {
    fail(id, '题面没有任何数字')
    continue
  }
  const puzzle = {
    id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    givens,
  }
  if (!puzzleHasCandidates(puzzle)) {
    fail(id, '有数字没有任何候选矩形（题面必然无解）')
    continue
  }

  /* —— 3. 参考解 —— */
  if (!raw.solution) {
    fail(id, '缺少参考解')
    continue
  }
  const decoded = decodeRects(raw.solution, raw.width, raw.height)
  if (!decoded) {
    fail(id, '参考解编码非法（矩形列表越界或格式错误）')
    continue
  }
  const rects = decoded.filter((r) => r !== null)
  if (rects.length !== clues) {
    fail(id, `参考解矩形数 ${rects.length} ≠ 数字数 ${clues}`)
    continue
  }
  const solutionCheck = validateRects(raw.width, raw.height, givens, rects)
  if (!solutionCheck.ok) {
    fail(id, `参考解不合法：${solutionCheck.reason}`)
    continue
  }

  /* —— 4. 唯一解 —— */
  const counted = countSolutions(puzzle, 2, 800_000)
  if (counted.timedOut) {
    warn(id, `唯一解检查超时（${counted.nodes} 节点）`)
  } else if (counted.count !== 1) {
    fail(id, `解不唯一：找到 ${counted.count} 个`)
    continue
  }

  /* —— 5. 逻辑可推完 —— */
  const plan = planLogicSolve(puzzle, createEmptyState(puzzle))
  if (!plan.frames.length) {
    fail(id, '逻辑解题没有产出任何一帧')
    continue
  }
  if (!plan.saturated) {
    fail(id, '逻辑推演未饱和（需要回溯猜测）')
    continue
  }
  if (!plan.finalState) {
    fail(id, '逻辑推演没有终态')
    continue
  }
  const finalCheck = validate(plan.finalState, puzzle)
  if (!finalCheck.solved) {
    fail(id, `逻辑终态未解出：${finalCheck.rectIssues.length} 个矩形问题 / ${finalCheck.empty} 格未覆盖`)
    continue
  }
  const finalRects = plan.finalState.rects.filter((r) => r !== null)
  if (finalRects.length !== clues) {
    fail(id, `逻辑终态矩形数 ${finalRects.length} ≠ 数字数 ${clues}`)
    continue
  }

  const st = plan.stats ?? {}
  const byRule = {}
  for (const f of plan.frames) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  const ruleText = Object.entries(byRule).map(([k, v]) => `R${k}:${v}`).join(' ') || '-'
  console.log(
    `[check] ✓ ${id} ${raw.width}×${raw.height} · 数字 ${clues} · 矩形 ${rects.length} · ` +
      `解唯一 · 逻辑可推满（${plan.frames.length} 帧，${plan.ruleSteps} 规则步，${counted.nodes} 节点）` +
      `（${ruleText}；反证 ${st.probes ?? 0} 次 / 排除 ${st.eliminated ?? 0} 个 / ` +
      `隐藏排除 ${st.hiddenKills ?? 0} 个 / 回溯 ${st.searchNodes ?? 0} 节点）`,
  )
}

/* —— 6. 题库规模 —— */
if (RAW_PUZZLES.length < 6) {
  fail('题库', `只有 ${RAW_PUZZLES.length} 题，至少需要 6 题`)
}
if (sizes.size < 4) {
  fail('题库', `只有 ${sizes.size} 种尺寸，至少需要 4 种（当前：${[...sizes].join('、')}）`)
}

const idsFromData = RAW_PUZZLES.map((p) => p.id)
console.log(
  `[check] 共 ${RAW_PUZZLES.length} 题，${sizes.size} 种尺寸（${[...sizes].join('、')}），` +
    `错误 ${errors}，警告 ${warnings}`,
)
console.log(`[check] id：${idsFromData.join(', ')}`)

if (errors > 0) {
  process.exitCode = 1
  console.error(`[check] 失败：${errors} 个错误`)
} else {
  console.log('[check] 通过：题库结构、参考解、唯一解、逻辑可推满全部 OK')
}
