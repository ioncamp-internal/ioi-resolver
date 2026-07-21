// 定案停頓的迴歸測試: node test_settle_queue.js (從 repo 根目錄跑)
//
// 揭曉必須在「每一隊」名次定案時停下來 focus 它 -- 包含封榜後完全沒有提交、
// 而且從頭到尾沒被別人擠動過的隊伍。那種隊伍沒有任何一筆 operation 掛在身上,
// 曾經因此被 settlePoints() 整個略過, 揭曉就永遠不會停在他們身上。
//
// 用合成資料而不是 contest.json -- contest.json 是產生出來的, 不進版控。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const $ = () => ({ find: () => ({ text: () => '' }) });
$.extend = (deep, target, src) => JSON.parse(JSON.stringify(src));
global.$ = $;
global.sleep = ms => new Promise(r => setTimeout(r, ms));
eval(fs.readFileSync(path.join(__dirname, 'hiho-resolver.js'), 'utf8'));

const FROZEN = 100;

function build(solutions) {
	const users = {};
	for (const s of solutions) users[s.user_id] = { name: s.user_id, college: '' };
	const byId = {};
	solutions.forEach((s, i) => { byId['s' + i] = s; });
	const r = new Resolver(byId, users, 2, FROZEN);
	r.calcOperations();
	r.buildSettleQueue();
	return r;
}

// 依 operation 順序把每個停頓點展平, 得到觀眾實際看到的 focus 次序(以最終列索引表示)
function focusOrder(r) {
	const ops = Object.keys(r.settle_by_op).map(Number).sort((a, b) => a - b);
	const order = [];
	for (const op of ops) for (const uid of r.settle_by_op[op]) order.push(r.final_row[uid]);
	return order;
}

function everyTeamStops(r, label) {
	const missing = Object.keys(r.final_row).filter(uid =>
		!Object.values(r.settle_by_op).some(batch => batch.indexOf(uid) !== -1));
	assert.deepStrictEqual(missing, [], label + ': 這些隊伍從來沒有被 focus 過 -> ' + missing);
}

// --- 案例 1: 未受影響的隊伍夾在中間(列 0 的第一名、列 2 的中段隊) ---
// T1 200 分, T3 50 分, 兩者都沒有封榜後提交也沒被擠動 -> 過去完全拿不到停頓點。
// T2/T4 有封榜後提交但翻完不會變動名次。
{
	const r = build([
		{ user_id: 'T1', problem_index: 1, verdict: 'AC',  submitted_seconds: 10 },
		{ user_id: 'T1', problem_index: 2, verdict: 'AC',  submitted_seconds: 20 },
		{ user_id: 'T2', problem_index: 1, verdict: 'AC',  submitted_seconds: 30 },
		{ user_id: 'T2', problem_index: 2, verdict: 'WA',  submitted_seconds: 150 },
		{ user_id: 'T3', problem_index: 1, verdict: 'P50', submitted_seconds: 40 },
		{ user_id: 'T4', problem_index: 2, verdict: 'P10', submitted_seconds: 160 },
	]);
	assert.deepStrictEqual(
		r.rank2.map(e => e.user_id), ['T1', 'T2', 'T3', 'T4'],
		'案例 1 前提: 沒有隊伍改變名次');
	everyTeamStops(r, '案例 1');
	assert.deepStrictEqual(focusOrder(r), [3, 2, 1, 0],
		'案例 1: 停頓必須由下往上逐列走完');
}

// --- 案例 2: 最後幾列都沒有 operation, 沒有「下面的停頓點」可以掛 ---
// 只有 T2 會翻牌, 其餘三隊都是未受影響的隊伍; 全部要掛到第一個停頓點上,
// 並且仍然由下往上排。
{
	const r = build([
		{ user_id: 'T1', problem_index: 1, verdict: 'AC',  submitted_seconds: 10 },
		{ user_id: 'T1', problem_index: 2, verdict: 'AC',  submitted_seconds: 20 },
		{ user_id: 'T2', problem_index: 1, verdict: 'AC',  submitted_seconds: 30 },
		{ user_id: 'T2', problem_index: 2, verdict: 'WA',  submitted_seconds: 150 },
		{ user_id: 'T3', problem_index: 1, verdict: 'P50', submitted_seconds: 40 },
		{ user_id: 'T4', problem_index: 1, verdict: 'P10', submitted_seconds: 50 },
	]);
	assert.deepStrictEqual(
		r.rank2.map(e => e.user_id), ['T1', 'T2', 'T3', 'T4'],
		'案例 2 前提: 沒有隊伍改變名次');
	everyTeamStops(r, '案例 2');
	assert.deepStrictEqual(focusOrder(r), [3, 2, 1, 0],
		'案例 2: 停頓必須由下往上逐列走完');
}

// --- 案例 3: 有隊伍上升時, 原本就正確的行為不能被破壞 ---
// T4 封榜後 AC 兩題(200 分)衝到第一; 每隊仍各自恰好被 focus 一次。
{
	const r = build([
		{ user_id: 'T1', problem_index: 1, verdict: 'AC',  submitted_seconds: 10 },
		{ user_id: 'T2', problem_index: 1, verdict: 'AC',  submitted_seconds: 30 },
		{ user_id: 'T3', problem_index: 1, verdict: 'P50', submitted_seconds: 40 },
		{ user_id: 'T4', problem_index: 1, verdict: 'AC',  submitted_seconds: 150 },
		{ user_id: 'T4', problem_index: 2, verdict: 'AC',  submitted_seconds: 160 },
	]);
	assert.strictEqual(r.final_row['T4'], 0, '案例 3 前提: T4 應該衝到第一');
	everyTeamStops(r, '案例 3');
	const order = focusOrder(r);
	assert.strictEqual(order.length, 4, '案例 3: 每隊只能被 focus 一次, 得到 ' + order);
	assert.deepStrictEqual(order.slice().sort((a, b) => a - b), [0, 1, 2, 3],
		'案例 3: 四列都要出現且不重複');
}

// --- 案例 4: 一支隊伍自己不動了, 但下面的隊伍還在互相超車 ---
// E 第一筆就衝到列 1 之後再也沒動過, 而列 2/3/4 一直換到最後一筆操作。
// 「自己不再移動」不等於可以確認名次 -- 要等下面每一隊都定案, 確認才不會回頭。
{
	const r = build([
		{ user_id: 'A', problem_index: 1, verdict: 'AC',  submitted_seconds: 10 },
		{ user_id: 'B', problem_index: 1, verdict: 'P50', submitted_seconds: 20 },
		{ user_id: 'C', problem_index: 1, verdict: 'P40', submitted_seconds: 30 },
		{ user_id: 'D', problem_index: 1, verdict: 'P30', submitted_seconds: 40 },
		{ user_id: 'E', problem_index: 1, verdict: 'AC',  submitted_seconds: 150 },
		{ user_id: 'D', problem_index: 2, verdict: 'P35', submitted_seconds: 160 },
		{ user_id: 'C', problem_index: 2, verdict: 'P45', submitted_seconds: 170 },
	]);
	assert.deepStrictEqual(
		r.rank2.map(e => e.user_id), ['A', 'E', 'C', 'D', 'B'],
		'案例 4 前提: E 衝到列 1, C/D/B 在下面重排');
	assert.strictEqual(r.operations[0].user_id, 'E', '案例 4 前提: E 是第一筆操作');
	everyTeamStops(r, '案例 4');
	assert.deepStrictEqual(focusOrder(r), [4, 3, 2, 1, 0],
		'案例 4: E(列 1)不能在列 2/3/4 定案之前就被確認');
}

console.log('ok  test_settle_queue.js: 4 cases passed');
