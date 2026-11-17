/**
 * 逻辑谜题模板 —— 通用核心类型
 *
 * 核心层完全不认识具体游戏。它只依赖下面这套「最小公共结构」：
 * - Puzzle：宽高 + id + 难度（游戏特有字段由各游戏扩展，核心不关心）
 * - GameState：棋盘状态（游戏特有字段扩展）
 * - Move：一次落子（index + from/to，from/to 用数字枚举，0 一律表示「未定」）
 * - ValidationResult：校验结果（至少含 solved）
 * - LogicPlan / PlaybackFrame：逻辑解题计划与动画帧
 *
 * 具体游戏通过实现 GameAdapter 把这些类型接进模板，详见 game/adapter.ts。
 */

/** 难度标签 */
export type Difficulty = 'easy' | 'medium' | 'hard' | 'custom'

/** 通用题面最小结构（各游戏在此基础上扩展自己的字段） */
export interface Puzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
}

/** 通用棋盘状态（各游戏扩展） */
export interface GameState {
  puzzleId: string
  width: number
  height: number
}

/** 一次落子：from/to 为数字枚举，0 = Unknown（所有游戏统一约定） */
export interface Move {
  /** 目标索引：格子 / 边 / 顶点，由游戏定义 */
  index: number
  from: number
  to: number
}

/** 校验结果：游戏扩展错误明细，至少给出 solved */
export interface ValidationResult {
  solved: boolean
}

/** 逻辑解题动画帧（回放的最小单位） */
export interface PlaybackFrame {
  /** 规则编号或 id（显示在状态栏） */
  rule: number | string
  /** 人类可读的推理说明 */
  label: string
  /** 这一帧落下的子 */
  move: Move
  /** 同规则连拍序号（1 起），用于音高抬升 / 动画加速 */
  streak: number
}

/** 逻辑解题计划：推理期一次性算完，回放期只读 */
export interface LogicPlan {
  puzzleId: string
  frames: PlaybackFrame[]
  /** 推理终态（与逐帧施加后一致） */
  finalState: GameState | null
  /** 规则步数（含无落子的推导步） */
  ruleSteps: number
  /** 是否已推到规则不动点 */
  saturated: boolean
  /** 推理诊断计数（规则命中 / 反证 / 搜索节点，审计脚本与 check 用） */
  stats?: Record<string, number>
}

/** 回溯求解结果 */
export interface SolveResult {
  solved: boolean
  solution: GameState | null
  /** 搜索节点数（状态栏/调试用） */
  nodes: number
  timedOut: boolean
}

/** 棋盘形状（square 之外的形状由游戏自行渲染/命中，核心只做元信息） */
export type BoardShape = 'square' | 'hex' | 'triangle'

/** 主命中目标类型 */
export type TargetKind = 'cell' | 'edge' | 'vertex'

/** 棋盘渲染度量：所有描边/字号按 10×10 基准格距等比缩放 */
export interface BoardMetrics {
  cell: number
  pad: number
  width: number
  height: number
  svgWidth: number
  svgHeight: number
  k: number
  /** 可选：棋盘区左上角；缺省时等于 pad */
  originX?: number
  originY?: number
  /** 可选：单元格宽高；缺省时等于 cell */
  cellW?: number
  cellH?: number
  /** 可选：四边留白（用于行列线索、刻度等） */
  padLeft?: number
  padTop?: number
  padRight?: number
  padBottom?: number
  /** 可选：棋盘形状（默认 square） */
  shape?: BoardShape
  /** 可选：主命中目标类型（默认 cell） */
  targetKind?: TargetKind
}

/** 命中目标：index 是游戏内部索引；kind/a/b/x/y 供边、顶点或复合棋盘使用 */
export interface HitTarget {
  index: number
  kind?: TargetKind
  /** 边的两个端点 / 顶点的相邻格 */
  a?: number
  b?: number
  /** 顶点坐标或格内相对位置（0..1） */
  x?: number
  y?: number
}

/** 游戏元信息：模板用它生成品牌区、快捷键说明、存储键、端口等 */
export interface GameMeta {
  /** 标题（顶栏 h1） */
  title: string
  /** 副标题（顶栏 p） */
  tagline: string
  /** 底部提示 */
  footerNote: string
  /** localStorage 旧键前缀（data/ 文件名不依赖它） */
  storageKeyPrefix: string
  /** 自定义题 id 前缀，如 'custom-' */
  customIdPrefix: string
  /** 自定义题板宽高范围 */
  customMinW: number
  customMinH: number
  customMaxW: number
  customMaxH: number
  /** 可选：主命中目标类型，仅用于界面图例 */
  targetKind?: TargetKind
  /** 可选：覆盖默认的交互说明（图例第一行） */
  interactionHint?: string
  /**
   * 可选：完全覆盖侧边栏的操作说明（每项一行，支持 <kbd>）。
   * 不提供时使用模板默认的「通用交互」图例。
   */
  legendLines?: string[]
}

/** 自定义题板支持：核心提供通用编辑器，游戏只需声明「值集合」和编解码 */
export interface CustomSupport {
  /**
   * 编辑器模式：
   *   cell    = 单元格填值（默认）
   *   region  = 单元格填区域号（编辑器外观同 cell）
   *   picture = 单元格画图案（编辑器外观同 cell）
   *   edge    = 编辑格子之间的边（需要 edgeValueCycle + makePuzzleFromEdges）
   *   none    = 本游戏不支持自定义题板
   */
  mode?: 'cell' | 'region' | 'picture' | 'edge' | 'none'
  /** 点击循环的值序列（null 表示空格；0 = Unknown 约定由 core 处理，编辑器不显式出现 0） */
  valueCycle: Array<number | null>
  /** 编辑器按键 0-9 对应的值：返回 undefined 表示该键不用 */
  keyForDigit(digit: number): number | null | undefined
  /** 编辑器格子显示文案 */
  cellLabel(v: number | null): string
  /** 编辑器格子附加 CSS 类（可选） */
  cellClass?(v: number | null): string
  /** 自定义题板提示文字 */
  hint: string
  /**
   * 可选：编辑器允许的最大数字（默认 9）。
   * 大于 9 时，键盘支持「继续按数字累积成多位数」（约 0.7s 内），
   * 鼠标点击仍按 valueCycle 循环。
   */
  maxValue?: number
  /**
   * 可选：保存 / 载入前校验题面（例如检查是否恰好一解）。
   * 返回 null 表示不校验；ok=false 时阻止保存并显示 message；
   * ok=true 时 message 作为提示附加在成功消息后。
   */
  validatePuzzle?(p: Puzzle): { ok: boolean; message: string; tone?: 'ok' | 'bad' } | null
  /** 把已保存的题面还原成编辑器网格（编辑功能用）；不支持则省略或返回 null */
  toGrid?(p: Puzzle): { width: number; height: number; grid: Array<number | null> } | null

  /** —— edge 模式专用 —— */
  /** 边的点击循环值序列 */
  edgeValueCycle?: Array<number | null>
  /** 边按钮显示文案（可选） */
  edgeLabel?(v: number | null): string
  /** 边的附加 CSS 类（可选） */
  edgeClass?(v: number | null): string
  /**
   * edge 模式下从边数组构造 Puzzle。
   * 边索引顺序由 core/board.ts 的 horizontalEdgeIndex / verticalEdgeIndex 定义：
   *   先所有水平边（逐行），再所有竖直边（逐行）。
   */
  makePuzzleFromEdges?(
    w: number,
    h: number,
    edges: Array<number | null>,
    existingId?: string,
  ): Puzzle

  /** 从编辑器网格构造 Puzzle（existingId 给稳定 id 用） */
  makePuzzle(w: number, h: number, grid: Array<number | null>, existingId?: string): Puzzle
  /** 把题面序列化成 library 条目字段（JSON 友好） */
  encodePuzzle(p: Puzzle): Record<string, unknown>
  /** 从 library 条目还原题面；不合法返回 null */
  decodePuzzle(record: Record<string, unknown>): Puzzle | null
}

/**
 * 游戏自定义盘面交互的宿主能力（模板提供，游戏侧调用）。
 *
 * 适用于「一次手势要写入多步 / 拖拽预览」这类无法用通用点击循环表达的交互
 * （例如数方的拖拽画矩形）。游戏声明 adapter.interaction 后，模板会把
 * 左键/右键/中键指针事件和键盘事件转交给游戏；中键平移和滚轮缩放仍由模板负责。
 */
export interface GameInteractionHost {
  puzzle: Puzzle
  state: GameState
  metrics: BoardMetrics
  /** 当前棋盘 SVG（可能因重绘而更换，每次事件重新读取） */
  svg: SVGSVGElement | null
  /** 客户端坐标 → viewBox 坐标 */
  toViewBox(clientX: number, clientY: number): { x: number; y: number } | null
  /** 提交一步：写入状态 + 撤销栈 + 进度；不会自动重绘 */
  commit(move: Move): void
  /** 重新校验 + 重绘 + 刷新题库列表与状态栏 */
  refresh(): void
  /** 只重绘棋盘（保留状态栏） */
  renderBoard(): void
  setStatus(text: string, tone?: 'ok' | 'bad' | 'solving' | ''): void
  undo(): void
  redo(): void
}

/** 游戏自定义盘面交互（可选）。模板只调用，不关心内部实现。 */
export interface GameInteraction {
  /** 换题 / 清空 / 填入参考解后重置交互内部状态 */
  reset?(puzzle: Puzzle, state: GameState): void
  pointerDown?(host: GameInteractionHost, e: PointerEvent): void
  pointerMove?(host: GameInteractionHost, e: PointerEvent): void
  pointerUp?(host: GameInteractionHost, e: PointerEvent): void
  pointerCancel?(host: GameInteractionHost): void
  /** 盘面键盘（方向键 / 回车 / Esc 等）；返回 true 表示已消费 */
  keyDown?(host: GameInteractionHost, e: KeyboardEvent): boolean
}

/**
 * 游戏适配器契约 —— 模板核心只依赖这个接口。
 *
 * 新游戏 = 实现一个 GameAdapter + 一份题库数据 + 一个入口 main.ts。
 */
export interface GameAdapter {
  meta: GameMeta
  /** 内置题库 */
  builtinPuzzles: Puzzle[]
  /** 参考解（提示一格 / 显示解用）；没有返回 null */
  getReferenceSolution(id: string): GameState | null

  // —— 棋盘状态 ——
  createEmptyState(puzzle: Puzzle): GameState
  cloneState(state: GameState): GameState
  /** 左键点击循环后的值（如 0→1→2→0） */
  cycleValue(state: GameState, target: HitTarget): number
  /** 右键直接写入的值（默认语义 = 打叉/排除，各游戏可覆盖） */
  rightClickValue(state: GameState, target: HitTarget): number
  applyMove(state: GameState, move: Move): void
  invertMove(move: Move): Move
  /** 读取某索引当前值（state 内部数组的取值入口） */
  valueAt(state: GameState, index: number): number
  serializeState(state: GameState): Record<string, unknown>
  deserializeState(data: Record<string, unknown>): GameState | null

  // —— 校验 ——
  validate(state: GameState, puzzle: Puzzle): ValidationResult
  /** 把校验结果转成状态栏片段（如 ['3 处三连', '第 2 行不平衡']） */
  statusBits(result: ValidationResult): string[]

  // —— 渲染与命中 ——
  metricsFor(puzzle: Puzzle): BoardMetrics
  renderBoard(puzzle: Puzzle, state: GameState, result: ValidationResult, colorGrid?: unknown): string
  hitTest(m: BoardMetrics, puzzle: Puzzle, x: number, y: number): HitTarget | null

  // —— 逻辑解题 ——
  planLogicSolve(puzzle: Puzzle, state: GameState): LogicPlan

  // —— 回溯求解 ——
  solvePuzzle(puzzle: Puzzle, maxNodes?: number): SolveResult

  // —— 提示一格 ——
  firstHintMove(state: GameState, solution: GameState): Move | null

  // —— 自定义题板 ——
  custom: CustomSupport

  /** 可选：接管盘面的指针 / 键盘交互（拖拽画矩形等） */
  interaction?: GameInteraction

  // —— 音效 / 特效 ——
  /** 根据 move 播放音效（from===0 通常表示落子=拨弦，否则=水滴） */
  playForMove(move: Move, streak: number): void
  /** 落子 SVG 特效；不实现则用 core/fx 的通用弦振/涟漪/pop */
  flashForMove?(svg: SVGSVGElement, move: Move, streak: number, m: BoardMetrics): void
}