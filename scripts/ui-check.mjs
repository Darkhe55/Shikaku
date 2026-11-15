/**
 * 数方（Shikaku）浏览器冒烟测试（Playwright + Edge）
 *
 * 前置：先启动 `npm run dev`（端口读 package.json 的 puzzle.port = 5214）。
 * 用法：node scripts/ui-check.mjs
 * 截图输出：output/playwright/*.png
 *
 * 覆盖：
 *   1. 页面骨架 / 题库列表 / 内置题渲染；
 *   2. 鼠标拖拽画矩形：按参考解逐个拖完 → 判定完成；
 *   3. 错误高亮：面积不符 / 数字未使用；
 *   4. 键盘：方向键移动选中格、Enter 开始/结束矩形、Esc 取消、撤销重做；
 *   5. 提示一格 / 显示解 / 逻辑解题回放；
 *   6. 自定义题板：录入数字 → 唯一解校验 → 保存 → 载入 → 求解 → 编辑回填 → 两步确认删除；
 *   7. 自定义题无解时拒绝保存。
 */

import fs from 'node:fs'
import { chromium } from 'playwright-core'
import { PORT } from './_port.mjs'

const executablePath =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const OUT_DIR = 'output/playwright'
fs.mkdirSync(OUT_DIR, { recursive: true })

const failures = []
const pageErrors = []

function check(ok, message) {
  if (ok) console.log(`  ✓ ${message}`)
  else {
    failures.push(message)
    console.error(`  ✗ ${message}`)
  }
}

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1320, height: 940 } })
page.on('pageerror', (e) => {
  pageErrors.push(e.message)
  console.log('PAGEERROR', e.message)
})
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    pageErrors.push(msg.text())
    console.log('CONSOLE', msg.text())
  }
})

const statusText = () => page.locator('#status').innerText()
const puzzleCount = () => page.locator('.puzzle-item').count()

async function selectPuzzle(id) {
  await page.locator(`.puzzle-item[data-id="${id}"]`).click()
  await page.waitForTimeout(150)
}

async function boardInfo() {
  return page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    if (!s) return null
    const p = g.adapter.builtinPuzzles.find((x) => x.id === s.puzzle.id) || s.puzzle
    const m = g.adapter.metricsFor(p)
    return {
      puzzleId: s.puzzle.id,
      width: p.width,
      height: p.height,
      cell: m.cell,
      pad: m.pad,
      givens: (p.givens || []).slice(),
      clueIndices: (p.givens || []).map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0),
    }
  })
}

async function liveRects() {
  return page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    return {
      rects: s.state.rects.filter(Boolean).map((r) => ({ ...r })),
      nextId: s.state.nextId,
    }
  })
}

/** 某格中心 → 客户端坐标（考虑 viewBox 缩放/平移） */
async function cellPoint(cell) {
  return page.evaluate((idx) => {
    const g = window.__game
    const s = g.getSession()
    const m = g.adapter.metricsFor(s.puzzle)
    const svg = document.querySelector('#board svg.board-svg')
    const ctm = svg.getScreenCTM()
    const pt = svg.createSVGPoint()
    pt.x = m.pad + ((idx % m.width) + 0.5) * m.cell
    pt.y = m.pad + (Math.floor(idx / m.width) + 0.5) * m.cell
    const p = pt.matrixTransform(ctm)
    return { x: p.x, y: p.y, cell: m.cell }
  }, cell)
}

/** 用鼠标从矩形左上格拖到右下格 */
async function dragRect(rect, width) {
  const start = rect.y * width + rect.x
  const end = (rect.y + rect.h - 1) * width + (rect.x + rect.w - 1)
  const a = await cellPoint(start)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  if (start === end) {
    // 1×1 矩形：小幅拖动超过阈值即可
    await page.mouse.move(a.x + a.cell * 0.15, a.y + a.cell * 0.15, { steps: 3 })
  } else {
    const b = await cellPoint(end)
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(a.x + (b.x - a.x) * (i / 6), a.y + (b.y - a.y) * (i / 6))
    }
  }
  await page.mouse.up()
  await page.waitForTimeout(80)
}

try {
  /* ───────────── 1. 页面骨架 / 内置题 ───────────── */
  console.log('\n[1] 页面与内置题库')
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#app[data-booted="1"]')
  await page.waitForSelector('#board svg.board-svg', { timeout: 10_000 })
  await page.waitForTimeout(250)

  const title = await page.title()
  const h1 = await page.locator('.brand h1').innerText()
  check(title.includes('数方'), `页面标题为「${title}」`)
  check(h1.includes('数方'), `顶栏标题为「${h1}」`)
  const initialCount = await puzzleCount()
  check(initialCount >= 8, `内置题库共 ${initialCount} 题`)

  const ids = await page.locator('.puzzle-item').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-id')).filter(Boolean),
  )
  const sizes = new Set()
  for (const id of ids) {
    const m = /shikaku-(\d+)x(\d+)/.exec(id)
    if (m) sizes.add(`${m[1]}x${m[2]}`)
  }
  check(sizes.size >= 4, `题目尺寸种类：${[...sizes].join('、')}`)

  await page.screenshot({ path: `${OUT_DIR}/01-initial.png`, fullPage: true })

  const info = await boardInfo()
  check(!!info && info.clueIndices.length > 0, `当前题 ${info?.puzzleId} 有 ${info?.clueIndices.length} 个数字`)
  const clueEls = await page.locator('.shk-clue').count()
  check(clueEls === info.clueIndices.length, `SVG 渲染数字 ${clueEls} 个与题面一致`)

  /* ───────────── 2. 鼠标拖拽画矩形 → 完成 ───────────── */
  console.log('\n[2] 鼠标拖拽画矩形（照参考解逐块拖）')
  await selectPuzzle('shikaku-5x5-02')
  const info2 = await boardInfo()
  const solution = await page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    const sol = g.adapter.getReferenceSolution(s.puzzle.id)
    return sol ? sol.rects.filter(Boolean).map((r) => ({ ...r })) : null
  })
  check(!!solution && solution.length > 0, `参考解含 ${solution?.length} 个矩形`)
  for (const rect of solution) {
    await dragRect(rect, info2.width)
  }
  const solvedStatus = await statusText()
  check(solvedStatus.includes('完成'), `拖完所有矩形后状态栏：${solvedStatus}`)
  check((await page.locator('#status.ok').count()) === 1, '状态栏进入完成态（绿色）')
  const solvedRects = await liveRects()
  check(solvedRects.rects.length === solution.length, `盘面矩形数 ${solvedRects.rects.length}`)
  await page.screenshot({ path: `${OUT_DIR}/02-solved.png`, fullPage: true })

  // 撤销 / 重做
  await page.keyboard.press('z')
  await page.waitForTimeout(150)
  check(!(await statusText()).includes('完成'), '撤销一步后不再是完成态')
  await page.keyboard.press('Shift+Z')
  await page.waitForTimeout(150)
  check((await statusText()).includes('完成'), '重做后恢复完成态')

  /* ───────────── 3. 错误高亮 ───────────── */
  console.log('\n[3] 实时校验与错误高亮')
  await page.locator('#btn-clear').click()
  await page.waitForTimeout(120)
  const badCells = await page.locator('.shk-bad-cell').count()
  check(badCells > 0, `清空后数字格提示未使用（${badCells} 格高亮）`)

  // 在数字 3 的格子上画 1×1 矩形 → 面积不符
  const clueCell = info2.clueIndices.find((i) => info2.givens[i] > 2)
  const v = info2.givens[clueCell]
  await dragRect({ x: clueCell % info2.width, y: Math.floor(clueCell / info2.width), w: 1, h: 1 }, info2.width)
  const errStatus = await statusText()
  check(errStatus.includes('面积'), `小矩形面积不符 → 状态栏：${errStatus}`)
  check((await page.locator('.shk-rect-error').count()) >= 1, '错误矩形有红色虚线边框')
  await page.screenshot({ path: `${OUT_DIR}/03-errors.png`, fullPage: true })

  // 右键删除
  const errCell = await cellPoint(clueCell)
  await page.mouse.click(errCell.x, errCell.y, { button: 'right' })
  await page.waitForTimeout(120)
  const afterErase = await liveRects()
  check(afterErase.rects.length === 0, `右键删除后矩形数 ${afterErase.rects.length}`)

  /* ───────────── 4. 键盘交互 ───────────── */
  console.log('\n[4] 键盘：方向键 / Enter / Esc / 撤销')
  await page.locator('#btn-clear').click()
  await page.waitForTimeout(100)
  const p00 = await cellPoint(0)
  await page.mouse.click(p00.x, p00.y)
  await page.waitForTimeout(80)
  check((await page.locator('.shk-cursor').count()) === 1, '单击选中后出现选中光标')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  const kbRects = await liveRects()
  const kb = kbRects.rects[0]
  check(
    !!kb && kb.x === 0 && kb.y === 0 && kb.w === 2 && kb.h === 2,
    `键盘拖出 2×2 矩形：${JSON.stringify(kb)}`,
  )
  const rectCountAfterKb = kbRects.rects.length

  // Esc 取消
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  const afterEsc = await liveRects()
  check(afterEsc.rects.length === rectCountAfterKb, 'Esc 取消绘制，矩形数不变')
  check((await statusText()).includes('取消'), 'Esc 后状态栏提示已取消')
  check((await page.locator('.shk-board').count()) === 1, 'Esc 不会清空盘面')

  // 键盘撤销
  await page.keyboard.press('z')
  await page.waitForTimeout(120)
  check((await liveRects()).rects.length === 0, 'Z 撤销键盘画出的矩形')

  /* ───────────── 5. 提示 / 显示解 / 逻辑回放 ───────────── */
  console.log('\n[5] 提示一格 / 显示解 / 逻辑解题回放')
  await page.locator('#btn-hint').click()
  await page.waitForTimeout(200)
  check((await liveRects()).rects.length >= 1, '提示一格后至少放入 1 个矩形')
  check((await statusText()).includes('提示'), '状态栏提示已给出提示一格')

  await page.locator('#btn-solve').click()
  await page.waitForTimeout(300)
  check((await statusText()).includes('参考解') || (await statusText()).includes('完成'), `显示解后：${await statusText()}`)
  check((await page.locator('#status.ok').count()) === 1, '显示解后状态栏为完成态（绿色）')
  const solvedClueCount = (await boardInfo()).clueIndices.length
  check((await liveRects()).rects.length === solvedClueCount, '参考解矩形数 = 数字数')

  await page.locator('#btn-clear').click()
  await page.waitForTimeout(120)
  await page.locator('#btn-logic').click()
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT_DIR}/04-logic.png`, fullPage: true })
  const logicDone = await page
    .waitForFunction(
      () => {
        const s = document.getElementById('status')?.textContent || ''
        return s.includes('回放完毕') || s.includes('逻辑解题完成')
      },
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check(logicDone, '逻辑解题回放完成')
  check((await statusText()).includes('完成'), `回放结束后盘面：${await statusText()}`)

  /* ───────────── 6. 自定义题板 ───────────── */
  console.log('\n[6] 自定义题板：录入 / 保存 / 载入 / 求解 / 编辑 / 删除')
  const beforeCustom = await puzzleCount()
  await page.locator('#btn-custom').click()
  await page.waitForTimeout(120)
  check(await page.locator('#custom-editor').isVisible(), '自定义题板面板打开')

  await page.fill('#custom-w', '3')
  await page.fill('#custom-h', '3')
  await page.locator('#custom-regen').click()
  await page.waitForTimeout(120)
  // 3×3：每行一个 3 格矩形，数字 3 放在第 0 列
  for (const idx of [0, 3, 6]) {
    const cell = page.locator(`.custom-cell[data-i="${idx}"]`)
    for (let k = 0; k < 3; k++) await cell.click()
  }
  await page.waitForTimeout(100)
  for (const idx of [0, 3, 6]) {
    const label = await page.locator(`.custom-cell[data-i="${idx}"]`).innerText()
    check(label.trim() === '3', `自定义格 ${idx} = ${label.trim()}`)
  }
  await page.screenshot({ path: `${OUT_DIR}/05-custom.png`, fullPage: true })

  await page.locator('#custom-save').click()
  await page.waitForTimeout(500)
  const saveMsg = await page.locator('#custom-msg').innerText()
  check(saveMsg.includes('已保存'), `保存自定义题：${saveMsg}`)
  check(saveMsg.includes('唯一解'), '保存时做了唯一解校验')
  const afterCustom = await puzzleCount()
  check(afterCustom === beforeCustom + 1, `题库从 ${beforeCustom} 增加到 ${afterCustom}`)
  await page.screenshot({ path: `${OUT_DIR}/06-custom-saved.png`, fullPage: true })

  // 载入 + 求解
  await page.locator('#custom-apply').click()
  await page.waitForTimeout(400)
  check((await statusText()).includes('已载入自定义'), `载入自定义题：${await statusText()}`)
  const customClues = await page.locator('.shk-clue').count()
  check(customClues === 3, `自定义题渲染 ${customClues} 个数字`)
  await page.locator('#btn-solve').click()
  await page.waitForTimeout(400)
  check((await statusText()).includes('可行解') || (await statusText()).includes('完成'), `自定义题可求解：${await statusText()}`)
  await page.screenshot({ path: `${OUT_DIR}/07-custom-solved.png`, fullPage: true })
  await page.locator('#custom-close').click()
  await page.waitForTimeout(100)

  // 编辑回填
  await page.locator('.puzzle-act[data-edit]').first().click()
  await page.waitForTimeout(300)
  check(await page.locator('#custom-editor').isVisible(), '点击「编辑」打开题板')
  const restored = await page.locator('.custom-cell[data-i="0"]').innerText()
  check(restored.trim() === '3', `编辑回填：格 0 = ${restored.trim()}`)
  const restored6 = await page.locator('.custom-cell[data-i="6"]').innerText()
  check(restored6.trim() === '3', `编辑回填：格 6 = ${restored6.trim()}`)
  await page.screenshot({ path: `${OUT_DIR}/08-custom-edit.png`, fullPage: true })
  await page.locator('#custom-close').click()
  await page.waitForTimeout(100)

  // 两步确认删除
  const delBtn = page.locator('.puzzle-act[data-del]').first()
  await delBtn.click()
  await page.waitForTimeout(120)
  check((await delBtn.innerText()).includes('确认'), '第一次点删除 → 进入二次确认')
  await delBtn.click()
  await page.waitForTimeout(300)
  const remaining = await page.evaluate(() =>
    [...document.querySelectorAll('.puzzle-item .title')].filter((el) => el.textContent.includes('自定义')).length,
  )
  check(remaining === 0, '二次确认后自定义题从题库删除')
  check((await puzzleCount()) === beforeCustom, `题库恢复为 ${beforeCustom} 题`)
  await page.screenshot({ path: `${OUT_DIR}/09-custom-deleted.png`, fullPage: true })

  // 无解题面拒绝保存
  console.log('\n[7] 自定义题无解时拒绝保存')
  await page.locator('#btn-custom').click()
  await page.waitForTimeout(120)
  await page.fill('#custom-w', '3')
  await page.fill('#custom-h', '3')
  await page.locator('#custom-regen').click()
  await page.waitForTimeout(120)
  await page.locator('.custom-cell[data-i="0"]').click() // 只有角落数字 1 → 必然无解
  await page.locator('#custom-save').click()
  await page.waitForTimeout(500)
  const badMsg = await page.locator('#custom-msg').innerText()
  check(badMsg.includes('无解'), `无解题面被拒绝：${badMsg}`)
  check((await puzzleCount()) === beforeCustom, '无解题面没有进入题库')
  await page.locator('#custom-close').click()

  /* ───────────── 汇总 ───────────── */
  console.log('\n[结果]')
  check(pageErrors.length === 0, `无页面报错（${pageErrors.length}）`)
  console.log(`截图目录：${OUT_DIR}`)
  if (failures.length) {
    console.error(`失败 ${failures.length} 项：`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('全部浏览器验证通过 OK')
  }
} catch (err) {
  console.error('测试中断：', err)
  process.exitCode = 1
} finally {
  await browser.close()
}
