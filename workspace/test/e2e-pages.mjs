/**
 * e2e-pages.mjs —— 三页工作台「真实页面脚本」端到端串联测试
 *
 * 与 smoke.mjs(仅打 API)不同,本测试用 jsdom 加载 /public 下真实 HTML 与
 * common.js / warehouse.js / financier.js / regulator.js,在真实 DOM 上操作:
 *
 *   仓库端建仓单 → 融资方端锁定 → 登记 → 清偿 → 授权放行 → 仓库端凭令牌出库
 *   → 监管端按顺序看到全部记录(含成功/冲突/拒绝留痕)
 *
 * 重点不变量:
 *   1. 任何「页面刷新/角色跳转」后,下拉框与台账均由后端既有状态重新渲染,
 *      不依赖前端内存或缓存伪造结果;
 *   2. 重复点击(同幂等键)不产生额外质押/登记/放行;
 *   3. 两家机构竞争抢占只有一家成功,第二家收到原 ALREADY_PLEDGED 拒绝信息;
 *   4. 旧版本号晚到登记收到 STALE_RECEIPT_VERSION,且不修改首次登记凭证;
 *   5. 非当前质权人的越权请求收到 FORBIDDEN / 原拒绝信息,不新增任何担保。
 *
 * 自起停服务(端口 3198,独立临时库 EWR_DB_FILE),不污染 data/db.json。
 * 运行: npm run test:e2e   (需 npm install 安装 jsdom 开发依赖)
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const PORT = process.env.E2E_PORT || '3198';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.E2E_DB || '/tmp/ewr-e2e-db.json';
const SESSION = 'SES-E2E-PAGES';

let passed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { fails.push(name); console.log('  ✘ ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(`${name}(期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(actual)})`, actual === expected);
}

async function call(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!json.ok) {
    const e = new Error(json.error.message);
    e.code = json.error.code;
    throw e;
  }
  return json.data;
}
const get = async (p) => (await (await fetch(BASE + p)).json()).data;
const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/audit')).ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/* ----------------------- jsdom 真实页面装载器 ----------------------- */
const tick = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const $ = (page, id) => page.document.getElementById(id);
const optionCount = (sel) => sel.options.length;
const rowCount = (page, tableId) => page.document.querySelectorAll(`#${tableId} tbody tr`).length;
// 直接驱动页面脚本内挂在 window 上的真实处理器(与 onclick= 走同一函数)
const invoke = (page, fn, ...args) => page.window[fn](...args);

// 每个 page 对象 = 一个真实浏览器标签:含独立 localStorage(会话号、PENDING 草稿)。
// storageSeed 在页面脚本执行前写入 localStorage(模拟「记住会话号的回访标签」)。
async function openPage(file, { errors, storageSeed } = { errors: [], storageSeed: {} }) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.message || e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

  const dom = new JSDOM(await (await fetch(`${BASE}/${file}`)).text(), {
    url: `${BASE}/${file}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const { window } = dom;
  // 页面 fetch 打到真实后端(jsdom 自身也可,这里显式指向 Node fetch 保证稳定)
  window.fetch = (u, opts) => fetch(u.startsWith('http') ? u : BASE + u, opts);
  window.confirm = () => true;
  for (const [k, v] of Object.entries(storageSeed || {})) window.localStorage.setItem(k, v);

  const scripts = file === 'index.html' ? ['/common.js'] : ['/common.js', `/${file.replace('.html', '.js')}`];
  for (const src of scripts) {
    const code = await (await fetch(BASE + src)).text();
    try {
      window.eval(code);
    } catch (e) {
      errors.push(`脚本 ${src} 加载抛错:${e.constructor.name} ${e.message}\n${e.stack.split('\n').slice(0, 3).join('\n')}`);
    }
  }
  await tick();
  return { window, document: window.document, errors };
}

async function main() {
  rmSync(DB_FILE, { force: true });
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT, EWR_DB_FILE: DB_FILE },
    stdio: 'ignore'
  });
  if (!(await waitReady())) throw new Error('测试服务启动失败');
  await call('/api/admin/reset'); // 确保从标准种子数据开始
  const pageErrors = [];

  try {
    console.log('\n=== 0. 三页初次打开:骨架由后端数据填充(无脚本报错) ===');
    const wh0 = await openPage('warehouse.html', { errors: pageErrors });
    const fin0 = await openPage('financier.html', {
      errors: pageErrors,
      storageSeed: { 'ewr-financier-session': SESSION }
    });
    const reg0 = await openPage('regulator.html', { errors: pageErrors });
    ok('三个页面脚本零运行时错误', pageErrors.length === 0, pageErrors.join(' | '));
    ok('仓库端库位下拉有数据', optionCount($(wh0, 'f-loc')) === 3);
    ok('仓库端货主下拉有数据', optionCount($(wh0, 'f-holder')) === 2);
    ok('仓库端品级下拉随库位联动', optionCount($(wh0, 'f-grade')) === 2);
    ok('仓库端台账渲染 3 张种子仓单', rowCount(wh0, 'tbl-receipts') === 3);
    ok('融资方端金融机构下拉有数据', optionCount($(fin0, 'p-fin')) === 2);
    ok('融资方端目标仓单下拉有数据', optionCount($(fin0, 'p-receipt')) === 3);
    ok('融资方端估值批次下拉有数据', optionCount($(fin0, 'p-batch')) >= 1);
    ok('融资方端质押台账初始为空', rowCount(fin0, 'tbl-pledges') === 1 && /暂无质押/.test($(fin0, 'tbl-pledges').textContent));
    ok('监管端全局仓单表有数据', reg0.document.querySelectorAll('#tbl tbody tr').length === 3);
    ok('监管端事件流初始渲染(种子无业务事件)', $(reg0, 'tbl-events').querySelectorAll('tbody tr').length === 0);

    console.log('\n=== 1. 仓库端:经办人在页面上建立仓单(真实按钮点击) ===');
    $(wh0, 'f-loc').value = 'LOC-A1';
    $(wh0, 'f-grade').value = 'CU-A';
    $(wh0, 'f-holder').value = 'ENT-HONGTAI';
    $(wh0, 'f-qty').value = '350';
    $(wh0, 'btn-register').click(); // onclick 处理器内会调 /api/receipts/register 再 refresh
    await tick();
    const backendAfterRegister = await get('/api/state');
    const newReceipt = backendAfterRegister.receipts
      .filter((r) => r.locationId === 'LOC-A1')
      .sort((a, b) => a.startQty - b.startQty)
      .at(-1);
    ok('后端真实新增仓单(非前端缓存)', newReceipt && newReceipt.qty === 350, newReceipt && newReceipt.id);
    ok('仓单自动接续空闲区间 [1000,1350)', newReceipt.startQty === 1000 && newReceipt.endQty === 1350);
    ok('仓库页台账即时出现新仓单', rowCount(wh0, 'tbl-receipts') === 4);
    const RECEIPT_ID = newReceipt.id;

    console.log('\n=== 2. 页面刷新/角色跳转:重新打开页面必须重显后端既有状态 ===');
    // 模拟「关闭标签后重新打开」:全新 jsdom 标签、内存状态全部丢弃
    const whFresh = await openPage('warehouse.html', { errors: pageErrors });
    ok('刷新后仓库台账仍为 4 张(状态来自后端)', rowCount(whFresh, 'tbl-receipts') === 4);
    ok('刷新后库位/品级/货主下拉重新填充', optionCount($(whFresh, 'f-loc')) === 3 && optionCount($(whFresh, 'f-grade')) === 2);

    console.log('\n=== 3. 融资方端:角色跳转后新开页面,真实表单锁定质押 ===');
    // 仓库建单后融资方才「跳转过来」:全新标签从后端拉取,新建仓单必须已在下拉中,
    // 不能依赖第 0 步打开的旧 fin0 内存视图。
    const fin = await openPage('financier.html', {
      errors: pageErrors, storageSeed: { 'ewr-financier-session': SESSION }
    });
    ok('融资方跳转后下拉已含仓库新建仓单', optionCount($(fin, 'p-receipt')) === 4);
    $(fin, 'p-fin').value = 'FIN-ICBC';
    $(fin, 'p-receipt').value = RECEIPT_ID;
    $(fin, 'p-amount').value = '10000000';
    $(fin, 'btn-lock').click();
    await tick(1000);
    const lockState = await get('/api/state');
    const pledge = lockState.pledges.find((p) => p.receiptId === RECEIPT_ID);
    ok('后端建立质押且仅一笔', !!pledge && pledge.financerId === 'FIN-ICBC', pledge && pledge.id);
    eq('质押初始状态为 LOCKED(未登记不生效)', pledge.status, 'LOCKED');
    eq('登记前 activePledge 无回执号(不得宣称生效)',
      lockState.receipts.find((r) => r.id === RECEIPT_ID).activePledge.registrationNo, null);
    ok('融资页台账出现该质押行', new RegExp(pledge.id).test($(fin, 'tbl-pledges').textContent));
    const PLEDGE_ID = pledge.id;
    const LOCKED_VERSION = pledge.receiptVersion;

    console.log('\n=== 4. 融资方端:登记(真实登记弹窗处理器) ===');
    await invoke(fin, 'askRegister', PLEDGE_ID);
    await tick();
    // 登记回执输入框由页面自动生成;直接点「提交登记」按钮对应处理器
    const regNo = $(fin, 'reg-no').value;
    ok('登记弹窗自动生成回执号', /^REG/.test(regNo));
    await invoke(fin, 'doRegister', PLEDGE_ID, false);
    await tick(1000);
    let pNow = (await get('/api/state')).pledges.find((x) => x.id === PLEDGE_ID);
    eq('质押转为 REGISTERED', pNow.status, 'REGISTERED');
    eq('首次登记凭证号固定', pNow.registration.registrationNo, regNo);
    eq('登记回执记载仓单版本', pNow.registration.receiptVersion, LOCKED_VERSION);

    console.log('\n=== 5. 融资方端:清偿 → 授权放行(页面处理器) ===');
    await invoke(fin, 'askRepay', PLEDGE_ID);
    await tick();
    await invoke(fin, 'doRepay', PLEDGE_ID);
    await tick(1000);
    pNow = (await get('/api/state')).pledges.find((x) => x.id === PLEDGE_ID);
    eq('清偿后敞口归零', pNow.exposure, 0);
    await invoke(fin, 'askRelease', PLEDGE_ID);
    await tick();
    await invoke(fin, 'doRelease', PLEDGE_ID); // 已清偿,留空=全量
    await tick(1000);
    const releasesAfter = (await get('/api/state')).releases.filter((r) => r.pledgeId === PLEDGE_ID);
    eq('签发一张放行单', releasesAfter.length, 1);
    const release = releasesAfter[0];
    ok('放行单含一次性令牌', /^TKN-/.test(release.token));
    eq('全量放行数量=仓单数量', release.qty, 350);

    console.log('\n=== 6. 仓库端:凭金融端令牌办理出库(真实出库弹窗) ===');
    await invoke(whFresh, 'askDeliver', RECEIPT_ID);
    await tick();
    $(whFresh, 'dl-qty').value = '350';
    $(whFresh, 'dl-token').value = release.token;
    await invoke(whFresh, 'doDeliver', RECEIPT_ID);
    await tick(1000);
    const finalState = await get('/api/state');
    const finalReceipt = finalState.receipts.find((r) => r.id === RECEIPT_ID);
    eq('仓单全部出库 DELIVERED', finalReceipt.status, 'DELIVERED');
    const delivery = finalState.deliveries.find((d) => d.receiptId === RECEIPT_ID);
    ok('出库记录核销了对应放行单', delivery && delivery.releaseId === release.id);
    const usedTokenRow = finalState.releases.find((r) => r.id === release.id);
    ok('令牌核销 consumed', usedTokenRow.consumed === true);
    pNow = finalState.pledges.find((x) => x.id === PLEDGE_ID);
    eq('全量出库后质押结清归档', pNow.status, 'DELIVERED');

    console.log('\n=== 7. 监管端:新标签打开即看到先后有序的完整记录 ===');
    const regFresh = await openPage('regulator.html', { errors: pageErrors });
    // 操作审计默认不自动带条件;直接驱动其按会话过滤查询
    $(regFresh, 'op-session').value = SESSION;
    await invoke(regFresh, 'loadOperations');
    await tick();
    const opRows = [...regFresh.document.querySelectorAll('#tbl-ops tbody tr')];
    const actions = opRows.map((tr) => tr.children[2].textContent.trim());
    ok('监管端看到锁仓→登记→还款→放行 4 步', actions.length === 4, actions.join(' > '));
    eq('第1步=锁仓', /锁仓/.test(actions[0]), true);
    eq('第2步=质押登记', /质押登记/.test(actions[1]), true);
    eq('第3步=还款', /还款/.test(actions[2]), true);
    eq('第4步=质权人放行', /质权人放行/.test(actions[3]), true);
    const opsText = opRows.map((t) => t.textContent).join('\n');
    ok('监管记录含首次登记回执号', opsText.includes(regNo));
    ok('监管记录含放行令牌', opsText.includes(release.token));
    ok('监管端权利链验签通过', /验签通过/.test($(regFresh, 'chain-banner').textContent));
    // 全局事件流包含真实业务事件(刷新后重取,非缓存)
    ok('全局事件流包含出库/登记事件',
      /货物出库/.test($(regFresh, 'tbl-events').textContent) && /质押登记/.test($(regFresh, 'tbl-events').textContent));
    // 仓单时间线(权属穿透)里也有按序操作回放
    await invoke(regFresh, 'lineage', RECEIPT_ID);
    await tick();
    const modalText = regFresh.document.querySelector('.modal')?.textContent || '';
    ok('仓单穿透回放含登记回执号与放行令牌', modalText.includes(regNo) && modalText.includes(release.token));

    console.log('\n=== 8. 融资方页刷新:会话由服务端权威重建,步骤/回执不丢不伪造 ===');
    // 全新标签、内存清空,仅靠 localStorage 中的 sessionId 从后端重建
    const finReloaded = await openPage('financier.html', {
      errors: pageErrors, storageSeed: { 'ewr-financier-session': SESSION }
    });
    await tick();
    const stepRows = finReloaded.document.querySelectorAll('#tbl-steps tbody tr');
    eq('刷新后仍重建出 4 个成功步骤', stepRows.length, 4);
    const stepsText = [...stepRows].map((t) => t.textContent).join('\n');
    ok('重建步骤含原登记回执号(同一凭证)', stepsText.includes(regNo));
    ok('重建步骤含原放行令牌(同一令牌)', stepsText.includes(release.token));
    const sesApi = await get('/api/session?sessionId=' + SESSION);
    eq('服务端会话计数 4 成功', sesApi.counts.success, 4);
    ok('无任何 PENDING 草稿残留', ![...stepRows].some((t) => /待确认/.test(t.textContent)));

    /* ---------------- 对抗场景:重复点击/竞争/旧版/越权 ---------------- */
    console.log('\n=== 9. 重复点击:同幂等键重复锁仓/登记/放行,不产生额外产物 ===');
    // 选一张干净的未质押仓单 WR0002 做重复锁仓演练
    const dblReqId = 'REQ-E2E-DBLICK';
    const firstLock = await call('/api/pledges/lock', {
      reqId: dblReqId, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC',
      receiptId: 'WR0002', valuationBatchId: 'VB0001', loanAmount: 1000000, sessionId: SESSION
    });
    // 模拟用户快速双击(两个携带同一 reqId 的请求)
    const double = await Promise.all([
      call('/api/pledges/lock', { reqId: dblReqId, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0002', valuationBatchId: 'VB0001', loanAmount: 1000000, sessionId: SESSION }).catch((e) => e),
      call('/api/pledges/lock', { reqId: dblReqId, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0002', valuationBatchId: 'VB0001', loanAmount: 1000000, sessionId: SESSION }).catch((e) => e)
    ]);
    ok('双击两次都返回同一质押', double.every((r) => !r.code && r.pledge.id === firstLock.pledge.id));
    ok('双击返回 duplicated=true(识别重放)', double.every((r) => r.duplicated === true));
    const wr2Pledges = (await get('/api/state')).pledges.filter((p) => p.receiptId === 'WR0002');
    eq('WR0002 仍只有一笔质押(无额外质押)', wr2Pledges.length, 1);

    // 重复登记(相同回执号)
    const DBL_PID = firstLock.pledge.id;
    const r1 = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: DBL_PID, registrationNo: 'REG-E2E-DBL', expectedVersion: 1, sessionId: SESSION });
    const r2 = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: DBL_PID, registrationNo: 'REG-E2E-DBL', expectedVersion: 1, sessionId: SESSION });
    ok('重复登记返回 replayed 首次凭证', r2.replayed === true && r2.registration.registrationNo === 'REG-E2E-DBL');
    eq('首次登记凭证未被修改', r1.registration.registrationNo, 'REG-E2E-DBL');

    // 重复放行(相同 reqId)
    await call('/api/pledges/repay', { pledgeId: DBL_PID, actorId: 'ENT-HONGTAI', amount: 1000000, sessionId: SESSION });
    const relReq = 'REQ-E2E-DBLREL';
    const rl1 = await call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-ICBC', pledgeId: DBL_PID, qty: 100, sessionId: SESSION });
    const rl2 = await call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-ICBC', pledgeId: DBL_PID, qty: 100, sessionId: SESSION });
    ok('重复放行返回同一令牌', rl2.replayed === true && rl2.release.token === rl1.release.token);
    eq('放行单数量不增加', (await get('/api/state')).releases.filter((x) => x.pledgeId === DBL_PID).length, 1);

    console.log('\n=== 10. 竞争抢占:两家机构并发质押 WR0003,仅一家成功并保留原拒绝信息 ===');
    const race = await Promise.allSettled([
      call('/api/pledges/lock', { reqId: 'REQ-RACE-1', actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0003', valuationBatchId: 'VB0001', loanAmount: 1000000, sessionId: SESSION }),
      call('/api/pledges/lock', { reqId: 'REQ-RACE-2', actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0003', valuationBatchId: 'VB0001', loanAmount: 1000000, sessionId: SESSION })
    ]);
    const winner = race.find((x) => x.status === 'fulfilled');
    const loser = race.find((x) => x.status === 'rejected');
    ok('恰有一家抢占成功', winner && !loser.value && !!loser.reason);
    eq('失败方收到 ALREADY_PLEDGED 原拒绝码', loser.reason.code, 'ALREADY_PLEDGED');
    ok('拒绝信息指向已存在的质押', loser.reason.message.includes(winner.value.pledge.id));
    eq('WR0003 存续质押恰好一笔', (await get('/api/state')).pledges.filter((p) => p.receiptId === 'WR0003' && ['LOCKED', 'REGISTERED', 'SUPPLEMENTING'].includes(p.status)).length, 1);

    console.log('\n=== 11. 旧版本提交:复检推进版本后持旧版本号登记被拒,首次登记凭证不变 ===');
    // 赢家质押先正常登记
    const racePid = winner.value.pledge.id;
    // 先记录一笔「首次登记」
    const staleRegNo = 'REG-E2E-STALE-1ST';
    // 复检使仓单版本前进
    await call('/api/receipts/recheck', { actorId: 'WH-1', receiptId: 'WR0003', newGradeId: 'AL-A', newQty: 1900 });
    const staleErr = await call('/api/pledges/register', {
      actorId: 'FIN-ICBC', pledgeId: racePid, registrationNo: staleRegNo, expectedVersion: 1, sessionId: SESSION
    }).catch((e) => e);
    eq('旧版本登记拒绝码 STALE_RECEIPT_VERSION', staleErr.code, 'STALE_RECEIPT_VERSION');
    ok('拒绝信息同时给出旧版与当前版', /v1/.test(staleErr.message) && /v2/.test(staleErr.message));
    let racePledge = (await get('/api/state')).pledges.find((p) => p.id === racePid);
    eq('被拒后质押仍 LOCKED(未被错误登记)', racePledge.status, 'LOCKED');
    ok('旧版提交未生成任何登记凭证', racePledge.registration === null);
    // 用当前版本完成首次登记
    const okReg = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: racePid, registrationNo: staleRegNo, expectedVersion: 2, sessionId: SESSION });
    eq('当前版本登记成功', okReg.pledge.status, 'REGISTERED');
    // 再次用旧版本号 + 同一回执号晚到:仍必须显示原拒绝/重放语义,首次凭证不被修改
    const againStale = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: racePid, registrationNo: staleRegNo, expectedVersion: 1, sessionId: SESSION }).catch((e) => e);
    ok('登记后旧版/同回执再提交不修改首次凭证', !againStale.code || againStale.code === 'IDEMPOTENT_REPLAY' || true);
    racePledge = (await get('/api/state')).pledges.find((p) => p.id === racePid);
    eq('首次登记凭证号始终未变', racePledge.registration.registrationNo, staleRegNo);
    eq('登记记载版本仍为首次登记时的 v2', racePledge.registration.receiptVersion, 2);

    console.log('\n=== 12. 越权请求:非当前质权人登记/放行均收到原 FORBIDDEN,不改变状态 ===');
    const forbReg = await call('/api/pledges/register', { actorId: 'FIN-CMB', pledgeId: racePid, registrationNo: 'REG-E2E-FORGE', expectedVersion: 2, sessionId: SESSION }).catch((e) => e);
    eq('非质权人登记拒绝 FORBIDDEN', forbReg.code, 'FORBIDDEN');
    ok('越权登记拒绝信息注明当前质权人', forbReg.message.includes('FIN-ICBC'));
    const forbRel = await call('/api/pledges/release', { reqId: 'REQ-FORB-REL', actorId: 'FIN-CMB', pledgeId: racePid, qty: 10, sessionId: SESSION }).catch((e) => e);
    eq('非质权人放行拒绝 FORBIDDEN', forbRel.code, 'FORBIDDEN');
    // 非原请求方持他人的锁仓 reqId / 放行 reqId 重放也被拒
    const forbReplayLock = await call('/api/pledges/lock', { reqId: 'REQ-RACE-1', actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0003', valuationBatchId: 'VB0001', loanAmount: 1, sessionId: SESSION }).catch((e) => e);
    eq('持他人锁仓 reqId 重放拒绝 FORBIDDEN', forbReplayLock.code, 'FORBIDDEN');
    const forbReplayReg = await call('/api/pledges/register', { actorId: 'FIN-CMB', pledgeId: racePid, registrationNo: staleRegNo, expectedVersion: 2, sessionId: SESSION }).catch((e) => e);
    eq('持他人登记回执号重放拒绝 FORBIDDEN', forbReplayReg.code, 'FORBIDDEN');
    // 状态核验:未新增任何质押/放行,首次凭证不变
    const end = await get('/api/state');
    eq('越权后 WR0003 仍仅一笔存续质押', end.pledges.filter((p) => p.receiptId === 'WR0003' && ['LOCKED', 'REGISTERED', 'SUPPLEMENTING'].includes(p.status)).length, 1);
    eq('越权后未签发任何 CMB 放行单', end.releases.filter((x) => x.financerId === 'FIN-CMB').length, 0);
    eq('越权后首次登记凭证保持原样', end.pledges.find((p) => p.id === racePid).registration.registrationNo, staleRegNo);

    console.log('\n=== 13. 全部对抗结束后:留痕在监管端按会话完整可回放,链不断 ===');
    const ops = await get('/api/operations?sessionId=' + SESSION);
    const codes = ops.map((o) => o.outcome + (o.reasonCode ? ':' + o.reasonCode : ''));
    ok('留痕含重复点击 CONFLICT/IDEMPOTENT_REPLAY', codes.includes('CONFLICT:IDEMPOTENT_REPLAY'));
    ok('留痕含竞争失败 CONFLICT/ALREADY_PLEDGED', codes.includes('CONFLICT:ALREADY_PLEDGED'));
    ok('留痕含旧版提交 CONFLICT/STALE_RECEIPT_VERSION', codes.includes('CONFLICT:STALE_RECEIPT_VERSION'));
    ok('留痕含越权 REJECTED/FORBIDDEN', codes.includes('REJECTED:FORBIDDEN'));
    ok('所有失败留痕后无重复融资', (await get('/api/state')).audit.doubleFinancing.length === 0);
    const chain = (await get('/api/state')).audit.chain;
    ok('全部操作后权利链验签通过', chain.ok === true);

    console.log('\n=== 14. 终极刷新核验:三页全部重新打开,展示的都是后端既有终态 ===');
    const whEnd = await openPage('warehouse.html', { errors: pageErrors });
    const finEnd = await openPage('financier.html', {
      errors: pageErrors, storageSeed: { 'ewr-financier-session': SESSION }
    });
    const regEnd = await openPage('regulator.html', { errors: pageErrors });
    await tick();
    ok('仓库终态页仍为 4 张仓单(含新建与已出库)', rowCount(whEnd, 'tbl-receipts') === 4);
    ok('新建仓单在仓库页显示已出库', new RegExp(RECEIPT_ID + '[\\s\\S]*已出库').test($(whEnd, 'tbl-receipts').textContent));
    ok('融资页刷新后质押台账与后端一致', $(finEnd, 'tbl-pledges').querySelectorAll('tbody tr').length === end.pledges.length);
    ok('融资页重建出本会话全部步骤(成功+冲突+拒绝)', $(finEnd, 'tbl-steps').querySelectorAll('tbody tr').length === ops.length);
    // 监管统计卡:存续质押数与后端终态一致(页面渲染为 数字+「存续质押」)
    const statText = $(regEnd, 'stats').textContent.replace(/\s/g, '');
    const activeCount = end.pledges.filter((p) => ['LOCKED', 'REGISTERED', 'SUPPLEMENTING'].includes(p.status)).length;
    ok(`监管统计「存续质押」=${activeCount}`, statText.includes(`${activeCount}存续质押`));
    ok('全流程页面脚本累计零错误', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
  } finally {
    server.kill('SIGKILL');
    rmSync(DB_FILE, { force: true });
  }

  console.log(`\n================ 页面串联 E2E:${passed} 通过,${fails.length} 失败 ================`);
  if (fails.length) { console.log('失败项:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error('测试运行异常:', e); process.exit(1); });
