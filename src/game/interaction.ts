/**
 * 数方 —— 盘面交互（左键拖拽画矩形 / 右键删除 / 键盘绘制）
 *
 * 交互约定：
 *   - 左键按下 → 拖到对角 → 松开：画一个矩形（覆盖到已有矩形时会先删掉它们）；
 *   - 左键单击（没拖动）：点在已有矩形上 = 取消它；点在空格/数字上 = 选中；
 *   - 右键：删除点到的矩形；
 *   - 方向键移动选中格；Enter 开始 / 结束矩形；Esc 取消；Backspace 删除选中格的矩形；
 *   - 中键拖拽平移、滚轮缩放由模板负责。
 *
 * 矩形用 Move(index=矩形 id, from/to=几何编码) 表示，和撤销/重做/回放天然兼容。
 */

import type { GameInteraction, GameInteractionHost } from '../core/types'
import { addLivePreview } from './render'
import {
  clueAt,
  asShikakuPuzzle,
  asShikakuState,
  rectCells,
  type Rect,
} from './types'
import { makeCreateMove, makeRemoveMove, overlappingRectIds, ownersOfCell } from './state'
import { validate } from './validate'
import { clampCell, rectBetween, resetUi, uiState, type PreviewRect } from './ui-state'

/* ────────────────────────── 小工具 ────────────────────────── */

function boardSize(host: GameInteractionHost): { w: number; h: number; size: number } {
  const w = host.puzzle.width
  const h = host.puzzle.height
  return { w, h, size: w * h }
}

/** 从客户端坐标取格子的原始行列（可能超出棋盘） */
function cellFromClient(host: GameInteractionHost, clientX: number, clientY: number): number | null {
  const vb = host.toViewBox(clientX, clientY)
  if (!vb) return null
  const m = host.metrics
  const { w, h } = boardSize(host)
  const col = Math.floor((vb.x - m.pad) / m.cell)
  const row = Math.floor((vb.y - m.pad) / m.cell)
  // 允许比棋盘多出一格，方便把矩形拖到最边上；再远就不追踪
  if (col < -1 || row < -1 || col > w || row > h) return null
  const cc = Math.max(0, Math.min(w - 1, col))
  const rr = Math.max(0, Math.min(h - 1, row))
  return rr * w + cc
}

/** 计算预览矩形（含数字数量 / 面积 / 匹配状态） */
function buildPreview(host: GameInteractionHost, anchor: number, cell: number): PreviewRect {
  const p = asShikakuPuzzle(host.puzzle)
  const { w } = boardSize(host)
  const box = rectBetween(anchor, cell, w)
  const rect: Rect = { x: box.x, y: box.y, w: box.w, h: box.h }
  const cells = rectCells(rect, w)
  let clues = 0
  let clueValue = 0
  for (const c of cells) {
    const v = clueAt(p, c)
    if (v > 0) {
      clues++
      clueValue = v
    }
  }
  const area = rect.w * rect.h
  const status: PreviewRect['status'] =
    clues === 0 ? 'warn' : clues > 1 ? 'bad' : clueValue === area ? 'ok' : 'bad'
  return { ...rect, area, clues, clueValue, status }
}

function previewText(pv: PreviewRect): string {
  const dims = `${pv.w}×${pv.h} = ${pv.area} 格`
  if (pv.clues === 0) return `拖拽预览 ${dims} · 框内没有数字`
  if (pv.clues > 1) return `拖拽预览 ${dims} · 框住 ${pv.clues} 个数字，需恰好 1 个`
  if (pv.clueValue !== pv.area) return `拖拽预览 ${dims} · 数字 ${pv.clueValue}，面积不符`
  return `拖拽预览 ${dims} · 数字 ${pv.clueValue} ✓ 松开左键落下`
}

function syncPreview(host: GameInteractionHost): void {
  const anchor = uiState.anchor
  const cursor = uiState.cursor
  if (anchor == null || cursor == null) {
    uiState.preview = null
  } else {
    uiState.preview = buildPreview(host, anchor, cursor)
  }
  if (host.svg) addLivePreview(host.svg, host.metrics, uiState.preview)
}

/** 把当前预览矩形真正落下（含替换重叠矩形） */
function commitPreview(host: GameInteractionHost): void {
  const anchor = uiState.anchor
  const cursor = uiState.cursor
  if (anchor == null || cursor == null) return
  const s = asShikakuState(host.state)
  const preview = buildPreview(host, anchor, cursor)
  const rect: Rect = { x: preview.x, y: preview.y, w: preview.w, h: preview.h }
  if (preview.area < 1) return

  // 先把重叠的旧矩形删掉（每条删除都是独立一步，撤销可逐步回退）
  const removed = overlappingRectIds(s, rect)
  let removedArea = 0
  for (const id of removed) {
    const r = s.rects[id]
    if (r) removedArea += r.w * r.h
    const move = makeRemoveMove(s, id)
    if (move) host.commit(move)
  }
  host.commit(makeCreateMove(s, rect))

  uiState.anchor = null
  uiState.preview = null
  uiState.keyboardDraw = false
  host.refresh()

  const result = validate(host.state, host.puzzle)
  if (result.solved) {
    host.setStatus(`完成！整个棋盘已划分正确（${result.rectCount} 个矩形）。`, 'ok')
    return
  }

  const parts = [`已画矩形 ${preview.w}×${preview.h}（${preview.area} 格）`]
  if (preview.clues === 0) parts.push('框内没有数字')
  else if (preview.clues > 1) parts.push(`框住 ${preview.clues} 个数字`)
  else parts.push(`数字 ${preview.clueValue}${preview.clueValue === preview.area ? ' 面积正确' : '，面积不符'}`)
  if (removed.length) parts.push(`替换了 ${removed.length} 个旧矩形（共 ${removedArea} 格）`)
  host.setStatus(parts.join(' · '))
}

/** 取消当前绘制 */
function cancelDraw(host: GameInteractionHost, message = '已取消当前矩形。'): void {
  uiState.anchor = null
  uiState.preview = null
  uiState.keyboardDraw = false
  host.renderBoard()
  host.setStatus(message)
}

/** 删除某格上的矩形（右键 / 单击 / 退格共用） */
function eraseAt(host: GameInteractionHost, cell: number, tone: 'click' | 'menu' | 'key'): boolean {
  const s = asShikakuState(host.state)
  const owners = ownersOfCell(s, cell)
  if (!owners.length) {
    host.setStatus(tone === 'menu' ? '这里没有矩形。' : '这里没有矩形，左键拖拽可以画一个新的。')
    return false
  }
  let area = 0
  for (const id of owners) {
    const r = s.rects[id]
    if (r) area += r.w * r.h
    const move = makeRemoveMove(s, id)
    if (move) host.commit(move)
  }
  host.refresh()
  host.setStatus(`已删除${owners.length > 1 ? ` ${owners.length} 个` : ''}矩形（共 ${area} 格）。`)
  return true
}

/** 选中格子的提示文案 */
function selectStatus(host: GameInteractionHost, cell: number): void {
  const p = asShikakuPuzzle(host.puzzle)
  const v = clueAt(p, cell)
  const m = host.metrics
  const col = (cell % m.width) + 1
  const row = Math.floor(cell / m.width) + 1
  if (v > 0) {
    host.setStatus(`已选中第 ${row} 行第 ${col} 列的数字 ${v}：拖拽 / 按 Enter 画一个 ${v} 格的矩形。`)
  } else {
    host.setStatus(`已选中第 ${row} 行第 ${col} 列：拖拽 / 按 Enter 开始画矩形。`)
  }
}

/* ────────────────────────── 指针交互 ────────────────────────── */

/** 本次按下是否拖动过（用来区分「单击」与「拖拽画矩形」） */
let dragMoved = false
/** 按下时的客户端坐标：完全没动才算单击，小幅抖动也当作拖拽（支持 1×1 矩形） */
let downX = 0
let downY = 0

function pointerDown(host: GameInteractionHost, e: PointerEvent): void {
  const cell = cellFromClient(host, e.clientX, e.clientY)
  if (cell == null) return

  if (e.button === 2) {
    eraseAt(host, cell, 'menu')
    return
  }
  if (e.button !== 0) return

  dragMoved = false
  downX = e.clientX
  downY = e.clientY
  uiState.cursor = cell
  uiState.anchor = cell
  uiState.keyboardDraw = false
  syncPreview(host)
}

function pointerMove(host: GameInteractionHost, e: PointerEvent): void {
  if (uiState.anchor == null) return
  const cell = cellFromClient(host, e.clientX, e.clientY)
  if (cell == null) return
  if (cell !== uiState.cursor) dragMoved = true
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) dragMoved = true
  uiState.cursor = cell
  syncPreview(host)
  if (uiState.preview) host.setStatus(previewText(uiState.preview))
}

function pointerUp(host: GameInteractionHost, e: PointerEvent): void {
  const anchor = uiState.anchor
  if (anchor == null) return
  const cell = cellFromClient(host, e.clientX, e.clientY)
  const end = cell ?? anchor

  if (dragMoved) {
    uiState.cursor = end
    commitPreview(host)
    dragMoved = false
    return
  }

  // 单击：点在矩形上 → 取消；点在空格/数字上 → 选中
  uiState.anchor = null
  uiState.preview = null
  uiState.keyboardDraw = false
  uiState.cursor = end
  const erased = eraseAt(host, end, 'click')
  if (!erased) {
    host.renderBoard()
    selectStatus(host, end)
  }
  dragMoved = false
}

function pointerCancel(host: GameInteractionHost): void {
  uiState.anchor = null
  uiState.preview = null
  uiState.keyboardDraw = false
  host.renderBoard()
}

/* ────────────────────────── 键盘交互 ────────────────────────── */

function moveCursor(host: GameInteractionHost, dx: number, dy: number): void {
  const { w, h, size } = boardSize(host)
  if (size <= 0) return
  const cur = uiState.cursor ?? 0
  const col = (cur % w) + dx
  const row = Math.floor(cur / w) + dy
  uiState.cursor = clampCell(Math.min(Math.max(row, 0), h - 1) * w + Math.min(Math.max(col, 0), w - 1), w, h)
  syncPreview(host)
  host.renderBoard()
  if (uiState.preview) host.setStatus(previewText(uiState.preview))
  else selectStatus(host, uiState.cursor)
}

function keyDown(host: GameInteractionHost, e: KeyboardEvent): boolean {
  const { size, w } = boardSize(host)
  if (size <= 0) return false

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault()
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      moveCursor(host, dx, dy)
      return true
    }
    case 'Enter': {
      e.preventDefault()
      if (uiState.anchor != null) {
        commitPreview(host)
      } else {
        const cell = uiState.cursor ?? 0
        uiState.cursor = cell
        uiState.anchor = cell
        uiState.keyboardDraw = true
        syncPreview(host)
        host.renderBoard()
        host.setStatus(
          `矩形起点在第 ${Math.floor(cell / w) + 1} 行第 ${(cell % w) + 1} 列；方向键调整对角，再按 Enter 落下，Esc 取消。`,
        )
      }
      return true
    }
    case 'Escape': {
      e.preventDefault()
      if (uiState.anchor != null) {
        cancelDraw(host)
      } else if (uiState.cursor != null) {
        uiState.cursor = null
        host.renderBoard()
        host.setStatus('已取消选中。')
      } else {
        host.setStatus('没有正在进行的操作（Esc 已拦截，不会清空盘面）。')
      }
      return true
    }
    case 'Backspace':
    case 'Delete': {
      e.preventDefault()
      const cell = uiState.cursor
      if (cell != null) eraseAt(host, cell, 'key')
      return true
    }
    default:
      break
  }

  // 其它按键交给模板；若正在绘制，先取消绘制避免状态悬空
  if (uiState.anchor != null) {
    uiState.anchor = null
    uiState.preview = null
    uiState.keyboardDraw = false
    host.renderBoard()
  }
  return false
}

/* ────────────────────────── 导出 ────────────────────────── */

export const interaction: GameInteraction = {
  reset() {
    resetUi()
    dragMoved = false
  },
  pointerDown,
  pointerMove,
  pointerUp,
  pointerCancel,
  keyDown,
}
