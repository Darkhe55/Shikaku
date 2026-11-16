/**
 * 数方（Shikaku）题面图片导入（全自动识图）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--width 40 --height 50] [--name 名称] [--series 识图]
 *                                  [--append] [--verify] [--dry] [--json out.json]
 *                                  [--map "簇=数字,..."] [--fix "x,y=值,..."]
 *
 * 流程：
 *   1. Playwright + Edge 打开图片到 canvas，取灰度像素；
 *   2. 用网格交点上的大圆点定位 40×50 格（原图是「点线网格」样式），并识别外边框；
 *   3. 每格中心附近的深色字形 = 数字（1–3 位），按 x 排序拼成该格的面积数字；
 *   4. 字形聚类 + 多字体多字号模板匹配自动判读 0–9（--map 可人工覆盖簇）；
 *   5. 结构校验：所有数字之和必须等于格子总数（数方的天然不变量），预览；
 *   6. --verify 调项目 solver 做求解 / 唯一性检查（大盘面超时只警告）；
 *   7. --append 写入 src/game/imported-puzzles.ts（不会被 npm run gen 覆盖）。
 *
 * 题面编码：通常沿用项目现有 base36 单字符格式；出现 >35 的数字时自动改用
 * 逗号分隔的十进制格式（`decodeClues` 已兼容两种），以便导入真实大盘面。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { decodeClues, encodeClues, decodeRects } from '../src/game/types.ts'
import { countSolutions, validateRects } from '../src/game/solver.ts'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function edgePath() {
  for (const c of EDGE_CANDIDATES) if (c && existsSync(c)) return c
  throw new Error('找不到 Edge 可执行文件，请用 EDGE_PATH 指定')
}

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
function arg(flag, fallback = '') {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
function argEq(flag) {
  for (const a of args) if (a.startsWith(flag + '=')) return a.slice(flag.length + 1)
  return null
}
const VALUE_FLAGS = new Set(['--name', '--series', '--json', '--map', '--fix', '--width', '--height'])
const imageArg = args.find((a) => !a.startsWith('--') && !VALUE_FLAGS.has(args[args.indexOf(a) - 1]))
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--width 40 --height 50] [--name 名称] [--series 识图] [--append] [--verify] [--dry] [--json out.json] [--map "簇=数字,..."] [--fix "x,y=值,..."]',
  )
  process.exit(1)
}
const IMAGE = path.resolve(imageArg)
if (!existsSync(IMAGE)) {
  console.error('找不到图片:', IMAGE)
  process.exit(1)
}

const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const nameOpt = arg('--name')
const series = arg('--series', '识图')
const jsonOut = arg('--json')
const append = has('--append')
const verifyOpt = has('--verify')
const dry = has('--dry')

const manualClusters = new Map()
const mapArg = argEq('--map') ?? arg('--map', '')
if (mapArg) {
  for (const pair of mapArg.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*=\s*(\d+)\s*$/.exec(pair)
    if (!m) {
      console.error(`--map 格式错误：${pair}（应为 簇号=数字）`)
      process.exit(1)
    }
    manualClusters.set(Number(m[1]), Number(m[2]))
  }
}
const cellFixes = new Map()
const fixArg = argEq('--fix') ?? arg('--fix', '')
if (fixArg) {
  for (const part of fixArg.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*=\s*(\d+)\s*$/.exec(part)
    if (!m) {
      console.error(`--fix 格式错误：${part}（应为 x,y=数字）`)
      process.exit(1)
    }
    cellFixes.set(`${m[1]},${m[2]}`, Number(m[3]))
  }
}

/* ───────────────────────── 浏览器端几何 + 字形提取 ───────────────────────── */

const dataUrl = `data:image/png;base64,${readFileSync(IMAGE).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: edgePath() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analysis = await page.evaluate(async ({ dataUrl, widthOpt, heightOpt }) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const W = img.naturalWidth
  const H = img.naturalHeight
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, W, H).data
  const gray = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 255 : 0.299 * px[(y * W + x) * 4] + 0.587 * px[(y * W + x) * 4 + 1] + 0.114 * px[(y * W + x) * 4 + 2])

  const components = (pick, minArea, maxArea) => {
    const seen = new Uint8Array(W * H)
    const out = []
    for (let y0 = 0; y0 < H; y0++) {
      for (let x0 = 0; x0 < W; x0++) {
        const k0 = y0 * W + x0
        if (seen[k0] || !pick(x0, y0)) continue
        let n = 0
        let minX = x0
        let maxX = x0
        let minY = y0
        let maxY = y0
        const st = [[x0, y0]]
        seen[k0] = 1
        while (st.length) {
          const [x, y] = st.pop()
          n++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
              const k = ny * W + nx
              if (seen[k] || !pick(nx, ny)) continue
              seen[k] = 1
              st.push([nx, ny])
            }
          }
        }
        if (n < minArea || n > maxArea) continue
        out.push({ n, minX, minY, maxX, maxY, bw: maxX - minX + 1, bh: maxY - minY + 1 })
      }
    }
    return out
  }

  const dark = (x, y) => gray(x, y) < 140
  const all = components(dark, 8, 100000)

  // 1) 网格交点大圆点：约 4–7px 的实心方块
  const dots = all.filter((c) => c.bw >= 3 && c.bw <= 8 && c.bh >= 3 && c.bh <= 8 && Math.abs(c.bw - c.bh) <= 2 && c.n >= 9)
  if (dots.length < 40) throw new Error(`只找到 ${dots.length} 个网格交点，题图样式可能不匹配`)
  const cluster1d = (values, tol) => {
    const sorted = values.slice().sort((a, b) => a - b)
    const out = []
    for (const v of sorted) {
      const last = out[out.length - 1]
      if (last && Math.abs(v - last.center) <= tol) {
        last.sum += v
        last.count++
        last.center = last.sum / last.count
      } else out.push({ center: v, sum: v, count: 1 })
    }
    return out
  }
  const dotXs = cluster1d(dots.map((c) => (c.minX + c.maxX) / 2), 6).map((c) => c.center)
  const dotYs = cluster1d(dots.map((c) => (c.minY + c.maxY) / 2), 6).map((c) => c.center)
  const gapX = []
  for (let i = 1; i < dotXs.length; i++) gapX.push(dotXs[i] - dotXs[i - 1])
  gapX.sort((a, b) => a - b)
  const pitch = gapX[Math.floor(gapX.length / 2)]
  if (!(pitch > 4)) throw new Error('无法计算格距')
  const colCount = widthOpt || Math.round((dotXs[dotXs.length - 1] - dotXs[0]) / pitch) + 2
  const rowCount = heightOpt || Math.round((dotYs[dotYs.length - 1] - dotYs[0]) / pitch) + 2
  const x0 = dotXs[0] - pitch
  const y0 = dotYs[0] - pitch
  if (colCount < 3 || rowCount < 3) throw new Error(`推断的格子数过小：${colCount}×${rowCount}`)

  // 2) 字形：数字（高 8–18 的深色连通域），排除交点圆点和虚线小点；
  //    个别相邻数字会粘连成一个宽连通域，按列墨迹最少处切开再逐字识别
  const NS = 20
  const darkCountIn = (x0, y0, x1, y1) => {
    let n = 0
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (dark(x, y)) n++
    return n
  }
  const glyphOfBox = (x0, y0, x1, y1) => {
    let ix0 = x1 + 1
    let iy0 = y1 + 1
    let ix1 = x0 - 1
    let iy1 = y0 - 1
    let ink = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!dark(x, y)) continue
        ink++
        if (x < ix0) ix0 = x
        if (x > ix1) ix1 = x
        if (y < iy0) iy0 = y
        if (y > iy1) iy1 = y
      }
    }
    if (ink < 8 || ix1 < ix0) return null
    const bw = ix1 - ix0 + 1
    const bh = iy1 - iy0 + 1
    const m = new Array(NS * NS).fill(0)
    for (let j = 0; j < NS; j++) {
      const sy = iy0 + Math.min(bh - 1, Math.floor((j * bh) / NS))
      for (let i = 0; i < NS; i++) {
        const sx = ix0 + Math.min(bw - 1, Math.floor((i * bw) / NS))
        m[j * NS + i] = dark(sx, sy) ? 1 : 0
      }
    }
    return { m, ink, w: bw, h: bh, x: x0, minX: ix0, maxX: ix1 }
  }
  // 在 [lo,hi] 内找墨迹最少的切分列
  const splitAt = (lo, hi, y0, y1) => {
    let bestX = lo
    let bestInk = Infinity
    for (let x = lo; x <= hi; x++) {
      const ink = darkCountIn(x, y0, x, y1)
      if (ink < bestInk) {
        bestInk = ink
        bestX = x
      }
    }
    return bestX
  }
  const glyphs = []
  for (const c of all) {
    if (c.bh < 8 || c.bh > 18) continue
    if (c.bw >= 3 && c.bh >= 3 && c.bh <= 8 && Math.abs(c.bw - c.bh) <= 2) continue
    const parts = []
    if (c.bw <= 16) {
      parts.push([c.minX, c.minY, c.maxX, c.maxY])
    } else {
      const k = Math.max(2, Math.min(3, Math.round(c.bw / 11.5)))
      const cuts = []
      let start = c.minX
      for (let i = 1; i < k; i++) {
        const expected = c.minX + Math.round((c.bw * i) / k)
        const cut = splitAt(Math.max(start + 2, expected - 4), Math.min(c.maxX - 2, expected + 4), c.minY, c.maxY)
        cuts.push(cut)
        start = cut
      }
      let from = c.minX
      for (const cut of cuts) {
        parts.push([from, c.minY, cut - 1, c.maxY])
        from = cut
      }
      parts.push([from, c.minY, c.maxX, c.maxY])
    }
    for (const [px0, py0, px1, py1] of parts) {
      const gl = glyphOfBox(px0, py0, px1, py1)
      if (!gl) continue
      const cx = (gl.minX + gl.maxX) / 2
      const cy = (c.minY + c.maxY) / 2
      const col = Math.floor((cx - x0) / pitch)
      const row = Math.floor((cy - y0) / pitch)
      if (col < 0 || row < 0 || col >= colCount || row >= rowCount) continue
      glyphs.push({ row, col, x: gl.minX, y: c.minY, m: gl.m, ink: gl.ink, w: gl.w, h: gl.h })
    }
  }

  return {
    W,
    H,
    colCount,
    rowCount,
    pitch: Number(pitch.toFixed(2)),
    x0: Number(x0.toFixed(1)),
    y0: Number(y0.toFixed(1)),
    dotCount: dots.length,
    glyphs,
  }
}, { dataUrl, widthOpt, heightOpt })

/* ───────────────────────── 字形模板 ───────────────────────── */

const NS = 20
const DIGITS = '0123456789'
const templates = await page.evaluate(({ NS, DIGITS }) => {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const g = canvas.getContext('2d', { willReadFrequently: true })
  const FONTS = ['Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Microsoft YaHei']
  const WEIGHTS = [400, 700]
  const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56]
  const out = {}
  for (const ch of DIGITS) out[ch] = []
  const norm = (data, threshold) => {
    let x0 = 96
    let y0 = 96
    let x1 = -1
    let y1 = -1
    let ink = 0
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        if (data[(y * 96 + x) * 4] >= threshold) continue
        ink++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (!ink) return null
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const m = new Array(NS * NS).fill(0)
    for (let j = 0; j < NS; j++) {
      const sy = y0 + Math.min(bh - 1, Math.floor((j * bh) / NS))
      for (let i = 0; i < NS; i++) {
        const sx = x0 + Math.min(bw - 1, Math.floor((i * bw) / NS))
        m[j * NS + i] = data[(sy * 96 + sx) * 4] < threshold ? 1 : 0
      }
    }
    return { m, w: bw, h: bh }
  }
  for (const font of FONTS) {
    for (const weight of WEIGHTS) {
      for (const size of SIZES) {
        for (const phase of [0, 0.25, 0.5, 0.75]) {
          for (const ch of DIGITS) {
            g.fillStyle = '#fff'
            g.fillRect(0, 0, 96, 96)
            g.fillStyle = '#000'
            g.font = `${weight} ${size}px "${font}"`
            g.textAlign = 'center'
            g.textBaseline = 'middle'
            g.fillText(ch, 48 + phase, 48 + phase)
            const data = g.getImageData(0, 0, 96, 96).data
            const t = norm(data, 128)
            if (t) out[ch].push({ m: t.m, w: t.w, h: t.h, font, weight, size })
          }
        }
      }
    }
  }
  return out
}, { NS, DIGITS })

function simShift(a, b, radius = 1) {
  let best = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      let inter = 0
      let uni = 0
      for (let j = 0; j < NS; j++) {
        const bj = j + dy
        for (let i = 0; i < NS; i++) {
          const av = a[j * NS + i]
          const bi = i + dx
          const bv = bj >= 0 && bj < NS && bi >= 0 && bi < NS ? b[bj * NS + bi] : 0
          if (av && bv) inter++
          if (av || bv) uni++
        }
      }
      const s = uni ? inter / uni : 0
      if (s > best) best = s
    }
  }
  return best
}

function clusterGlyphs(glyphs, threshold) {
  const clusters = []
  for (const glyph of glyphs) {
    let best = -1
    let bi = -1
    for (let k = 0; k < clusters.length; k++) {
      const s = simShift(glyph.m, clusters[k].proto)
      if (s > best) {
        best = s
        bi = k
      }
    }
    if (bi >= 0 && best >= threshold) {
      const cl = clusters[bi]
      cl.count++
      for (let i = 0; i < glyph.m.length; i++) cl.sum[i] += glyph.m[i]
      for (let i = 0; i < glyph.m.length; i++) cl.proto[i] = cl.sum[i] / cl.count >= 0.5 ? 1 : 0
    } else {
      clusters.push({ count: 1, sum: glyph.m.slice(), proto: glyph.m.slice() })
    }
  }
  clusters.sort((a, b) => b.count - a.count)
  return clusters
}

/* ───────────────────────── 判读 ───────────────────────── */

if (!analysis.glyphs.length) {
  console.error('[import] 没有识别到任何数字')
  process.exit(1)
}
const clusters = clusterGlyphs(analysis.glyphs, 0.86)
const clusterTable = clusters.map((cl, k) => {
  const scores = DIGITS.split('').map((ch) => {
    let best = 0
    let meta = null
    for (const t of templates[ch]) {
      const s = simShift(cl.proto, t.m)
      if (s > best) {
        best = s
        meta = t
      }
    }
    return { ch, score: best, meta }
  })
  scores.sort((a, b) => b.score - a.score)
  const manual = manualClusters.get(k)
  return {
    k,
    count: cl.count,
    label: manual ?? Number(scores[0].ch),
    auto: Number(scores[0].ch),
    margin: scores[0].score - scores[1].score,
    scores: scores.slice(0, 3),
    manual: manual !== undefined,
  }
})
console.log(
  `[import] ${path.basename(IMAGE)}：${analysis.W}×${analysis.H}px，格距 ${analysis.pitch}px，` +
    `识别 ${analysis.colCount}×${analysis.rowCount}（交点 ${analysis.dotCount}，数字字形 ${analysis.glyphs.length}）`,
)
console.log('[import] 字形簇判读（--map 簇号=数字 可人工覆盖）：')
for (const row of clusterTable) {
  const flag = row.manual ? '人工' : row.margin < 0.05 ? '低置信' : '自动'
  console.log(
    `  簇${String(row.k).padStart(2)} n=${String(row.count).padStart(3)} → ${row.label}（${flag}，` +
      `${row.scores.map((s) => `${s.ch}:${s.score.toFixed(2)}`).join(' ')}）`,
  )
}
const labelOf = new Map(clusterTable.map((row) => [row.k, row.label]))
function clusterIndexFor(glyph) {
  let best = -1
  let bi = 0
  clusters.forEach((cl, k) => {
    const s = simShift(glyph.m, cl.proto)
    if (s > best) {
      best = s
      bi = k
    }
  })
  return bi
}

const W = analysis.colCount
const H = analysis.rowCount
// 按格收集字形，横向拼接成数字
const perCell = new Map()
for (const glyph of analysis.glyphs) {
  const key = glyph.row * W + glyph.col
  if (!perCell.has(key)) perCell.set(key, [])
  perCell.get(key).push(glyph)
}
const givens = new Array(W * H).fill(0)
for (const [key, list] of perCell) {
  list.sort((a, b) => a.x - b.x)
  let text = ''
  let low = false
  for (const glyph of list) {
    const label = labelOf.get(clusterIndexFor(glyph)) ?? 0
    const confidence = clusterTable[clusterIndexFor(glyph)]?.margin ?? 0
    if (confidence < 0.05) low = true
    text += String(label)
  }
  if (low) console.warn(`[import] 格 (${key % W},${(key / W) | 0}) 的数字来自低置信簇：${text}`)
  givens[key] = Number(text)
}

for (const [key, v] of cellFixes) {
  const [x, y] = key.split(',').map(Number)
  if (x < 0 || y < 0 || x >= W || y >= H) {
    console.warn(`[import] --fix ${key} 越界，忽略`)
    continue
  }
  givens[y * W + x] = v
}

/* ───────────────────────── 校验 + 预览 ───────────────────────── */

const issues = []
const clueCount = givens.filter((v) => v > 0).length
const clueSum = givens.reduce((s, v) => s + v, 0)
if (clueCount === 0) issues.push('题面没有任何数字')
if (clueSum !== W * H) {
  issues.push(`数字之和 ${clueSum} ≠ 格子总数 ${W * H}（差 ${clueSum - W * H}）：识别可能有误，可用 --map / --fix 修正`)
}
const zeroCells = givens.filter((v) => v === 0).length
if (W * H > 400 && clueCount < 2) issues.push('数字过少，可能不是数方题面')
console.log(`[import] 识别题面 ${W}×${H}（数字 / 空白）：`)
for (let y = 0; y < H; y++) {
  const row = []
  for (let x = 0; x < W; x++) {
    const v = givens[y * W + x]
    row.push(v ? String(v).padStart(3) : '  .')
  }
  console.log('  ' + String(y).padStart(2) + ' ' + row.join(''))
}
console.log(`[import] 数字 ${clueCount} 个，空格 ${zeroCells} 个，数字和 ${clueSum} / 格子总数 ${W * H}`)
if (issues.length) {
  console.error(`[import] 题面结构问题 ${issues.length} 个：`)
  for (const msg of issues) console.error('  - ' + msg)
  process.exitCode = 2
}

/* ───────────────────────── 求解校验（可选） ───────────────────────── */

let solutionText = ''
let unique = false
if (!issues.length && verifyOpt) {
  const t0 = Date.now()
  const puzzle = {
    id: 'import-temp',
    name: 'import-temp',
    width: W,
    height: H,
    difficulty: 'hard',
    givens,
  }
  const counted = countSolutions(puzzle, 2, 800_000)
  if (counted.timedOut) {
    console.warn(`[import] 唯一性检查超时（${counted.nodes} 节点，${Date.now() - t0}ms），仅警告`)
  } else if (counted.count === 0) {
    console.warn('[import] 题面无解：识别结果可能有误')
  } else if (counted.count > 1) {
    console.warn(`[import] 解不唯一（至少 ${counted.count} 个），参考解留空`)
  } else {
    unique = true
    console.log(`[import] 唯一解 ✓（${Date.now() - t0}ms，${counted.nodes} 节点）`)
  }
}

/* ───────────────────────── 导出 / 写入 ───────────────────────── */

const id = `shikaku-img-${W}x${H}-${Date.now().toString(36)}`
const name = nameOpt || `识图 · 数方 ${W}×${H}`
const maxClue = givens.reduce((m, v) => Math.max(m, v), 0)
// >35 的数字无法用单字符 base36 表示，改用逗号十进制（decodeClues 两种都支持）
const wide = maxClue >= 36
const boardText = wide ? givens.map((v) => String(v)).join(',') : encodeClues(givens)
if (wide) console.log(`[import] 最大数字 ${maxClue} > 35，题面编码改用逗号十进制格式`)

if (jsonOut) {
  const file = path.resolve(jsonOut)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ width: W, height: H, givens, board: boardText, unique, source: path.basename(IMAGE) }, null, 2) + '\n',
  )
  console.log(`[import] 已导出 JSON：${file}`)
}

if (append) {
  if (dry) {
    console.log('[import] --dry：跳过写入')
  } else if (issues.length) {
    console.error('[import] 题面结构有问题，拒绝写入（可用 --fix 修正后重跑）')
    process.exitCode = 2
  } else {
    const file = path.resolve('src/game/imported-puzzles.ts')
    const entry =
      `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${W}, height: ${H}, ` +
      `difficulty: 'hard', series: ${JSON.stringify(series)}, board: ${JSON.stringify(boardText)}, ` +
      `solution: ${JSON.stringify(solutionText)} },\n`
    if (!existsSync(file)) {
      writeFileSync(
        file,
        `/* 图片识别导入的题（scripts/import-image.mjs --append 写入；npm run gen 不会覆盖） */\n` +
          `import type { RawPuzzle } from './puzzles-data'\n\nexport const IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}]\n`,
      )
    } else {
      let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      const marker = text.lastIndexOf(']')
      if (marker < 0) throw new Error('imported-puzzles.ts 格式异常：找不到结尾 ]')
      text = text.slice(0, marker).replace(/\s+$/, '') + '\n' + entry + text.slice(marker)
      writeFileSync(file, text)
    }
    console.log(`[import] 已写入 ${file}：${id} ${name}`)
  }
} else {
  console.log('[import] 预览模式（未写入）。加 --append 写入 src/game/imported-puzzles.ts。')
}

await browser.close()
