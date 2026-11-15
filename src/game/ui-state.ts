/**
 * 数方 —— 交互层的临时状态（不写入存档，只影响渲染）
 *
 * 放在单独模块里，渲染层与交互层都只依赖它，避免循环引用。
 */

export interface PreviewRect {
  x: number
  y: number
  w: number
  h: number
  area: number
  /** 预览框内数字个数 */
  clues: number
  /** 恰好一个数字时它的值，否则 0 */
  clueValue: number
  /** ok = 面积正好等于数字；warn = 还没框到数字；bad = 数字/面积不匹配 */
  status: 'ok' | 'warn' | 'bad'
}

export interface GameUiState {
  /** 当前选中的格子（键盘光标） */
  cursor: number | null
  /** 正在拖拽 / 键盘绘制时的起点格 */
  anchor: number | null
  /** 拖拽中的矩形预览 */
  preview: PreviewRect | null
  /** 是否处于「键盘绘制」模式（Enter 开始、Enter 结束） */
  keyboardDraw: boolean
}

export const uiState: GameUiState = {
  cursor: null,
  anchor: null,
  preview: null,
  keyboardDraw: false,
}

export function resetUi(): void {
  uiState.cursor = null
  uiState.anchor = null
  uiState.preview = null
  uiState.keyboardDraw = false
}

/** 把任意格子索引夹到棋盘内 */
export function clampCell(cell: number, width: number, height: number): number {
  const size = width * height
  if (size <= 0) return 0
  if (!Number.isFinite(cell)) return 0
  return Math.max(0, Math.min(size - 1, Math.floor(cell)))
}

/** 两格之间围出的矩形（含首尾格） */
export function rectBetween(
  a: number,
  b: number,
  width: number,
): { x: number; y: number; w: number; h: number } {
  const ax = a % width
  const ay = Math.floor(a / width)
  const bx = b % width
  const by = Math.floor(b / width)
  const x = Math.min(ax, bx)
  const y = Math.min(ay, by)
  return { x, y, w: Math.abs(ax - bx) + 1, h: Math.abs(ay - by) + 1 }
}
