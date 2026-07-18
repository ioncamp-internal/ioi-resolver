/**
 *  admin.js -- 頒獎投影片設定頁
 *
 *  純瀏覽器編輯: 讀 slides.json 與 contest.json, 在頁面上改, 最後下載一份新的
 *  slides.json 自己放回去。伺服器是 python3 -m http.server, 不接受寫入。
 *
 *  重點是「解析預覽」: 直接重用 hiho-resolver.js 跑真正的揭曉模擬, 所以每條規則
 *  會落在哪一隊、哪幾條會被同隊的其他規則吃掉, 存檔前就看得到。
 */

// hiho-resolver.js 的 calcOperations 需要一個全域 sleep。
// 不載入 js/main.js -- 那會把整個揭曉也啟動起來。
function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

var IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

var state = {
    config: null,      // 編輯中的 slides.json
    resolver: null,    // 已跑過 calcOperations/buildSettleQueue
    images: [],        // slides/ 目錄裡的圖片檔名
    imagesOk: false,   // 圖片清單拿得到嗎(拿不到就退回手填)
    canWrite: false    // 是否連到 admin 埠 -- 只有本機才有寫入能力
};

// ---------------------------------------------------------------------------
// 載入
// ---------------------------------------------------------------------------

function loadJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function(res){
        if(!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
        return res.json();
    });
}

// 優先問 admin API(它同時代表「這台可以寫入」), 拿不到就退回解析目錄列表,
// 再不行就讓使用者自己填檔名。
function loadImages(dir) {
    return fetch('api/images', { cache: 'no-store' })
        .then(function(res){ if(!res.ok) throw new Error('no api'); return res.json(); })
        .then(function(j){
            state.images = j.images || [];
            state.imagesOk = true;
            state.canWrite = true;
        })
        .catch(function(){ return loadImagesFromListing(dir); });
}

function loadImagesFromListing(dir) {
    return fetch(dir.replace(/\/*$/, '/'), { cache: 'no-store' })
        .then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        })
        .then(function(html){
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var names = [];
            doc.querySelectorAll('a[href]').forEach(function(a){
                var href = decodeURIComponent(a.getAttribute('href'));
                if(IMAGE_EXT.test(href)) names.push(href.replace(/^.*\//, ''));
            });
            state.images = names.sort();
            state.imagesOk = true;
        })
        .catch(function(){
            state.images = [];
            state.imagesOk = false;
        });
}

function defaultConfig() {
    return { version: 1, slides_dir: 'slides',
             include_first_to_solve_before_freeze: true, rules: [] };
}

// ---------------------------------------------------------------------------
// 解析: 重用真正的揭曉邏輯
// ---------------------------------------------------------------------------

function buildResolver(contest) {
    var r = new Resolver(contest.solutions, contest.users,
                         contest.problem_count, contest.frozen_second);
    r.calcOperations();     // 收尾的 DOM 查詢在這個頁面上會是空集合, 無害
    r.buildSettleQueue();
    return r;
}

function resolve() {
    // resolveSlides 會重設 slides_by_team / collisions / rule_outcomes
    state.resolver.resolveSlides(state.config);
    return state.resolver.rule_outcomes || [];
}

// ---------------------------------------------------------------------------
// 畫面
// ---------------------------------------------------------------------------

var STATUS_TEXT = {
    unmatched:      '沒有對應的隊伍 — 這張不會播',
    'never-settles':'該隊沒有任何翻牌事件, 無處可掛 — 這張不會播',
    'unknown-type': '類型無效 — 這張不會播',
    empty:          '沒有圖片也沒有文字 — 這張不會播'
};

// 重建整份清單。只在結構改變(新增/刪除/搬移)時呼叫 --
// 編輯欄位時重建會讓輸入框失焦, 打一個字就跳掉。
function render() {
    var host = document.getElementById('rules');
    host.textContent = '';
    var tpl = document.getElementById('rule-tpl');

    state.config.rules.forEach(function(rule, i){
        var node = tpl.content.cloneNode(true);
        var el = node.querySelector('.rule');
        el.dataset.i = i;
        el.querySelector('.rule-no').textContent = '規則 ' + (i + 1);
        var type = rule.type || 'rank';
        el.querySelector('[data-f=type]').value = type;
        // 用不到的欄位直接從 DOM 拿掉, 不是藏起來
        el.querySelectorAll('[data-when]').forEach(function(f){
            if(f.dataset.when !== type) f.remove();
        });
        var rankIn = el.querySelector('[data-f=rank]');
        if(rankIn) rankIn.value = rule.rank != null ? rule.rank : '';
        var probIn = el.querySelector('[data-f=problem]');
        if(probIn) probIn.value = rule.problem != null ? rule.problem : '';
        el.querySelector('[data-f=citation]').value = rule.citation || '';
        fillImages(el.querySelector('[data-f=image]'), rule.image);
        host.appendChild(node);
    });
    refresh();
}

// 重跑解析, 就地更新落點、預覽與摘要, 不動 DOM 結構
function refresh() {
    var byIndex = {};
    resolve().forEach(function(o){ byIndex[o.index] = o; });

    var cards = document.querySelectorAll('.rule');
    var ok = 0;
    Array.prototype.forEach.call(cards, function(el, i){
        var o = byIndex[i];
        if(o && o.status === 'ok') ok++;
        showTarget(el.querySelector('.target'), o);
        showPreview(el.querySelector('.preview'), state.config.rules[i]);
    });

    var total = state.config.rules.length;
    document.getElementById('summary').textContent =
        total + ' 條規則 → ' + ok + ' 張會播出' + (total - ok ? ', ' + (total - ok) + ' 條不會' : '');
    var dir = (state.config.slides_dir || 'slides').replace(/\/*$/, '/');
    document.getElementById('dir-hint').textContent = dir;
    var h2 = document.getElementById('dir-hint2');
    if(h2) h2.textContent = dir;
}

function fillImages(select, current) {
    select.textContent = '';
    var blank = new Option('（不用圖片, 只顯示文字）', '');
    select.appendChild(blank);

    var known = state.images.slice();
    // 設定裡指到但目錄中不存在的圖也要列出來, 否則一選就被清掉
    if(current && known.indexOf(current) === -1) known.push(current);
    known.forEach(function(name){
        var missing = state.images.indexOf(name) === -1;
        select.appendChild(new Option(missing ? name + '（檔案不存在）' : name, name));
    });
    select.value = current || '';
    select.disabled = false;
    if(!state.imagesOk && !known.length)
        select.appendChild(new Option('（讀不到圖片目錄）', ''));
}

function showTarget(p, o) {
    if(!o) { p.className = 'target'; p.textContent = ''; return; }
    if(o.status === 'ok') {
        p.className = 'target ok';
        p.textContent = '落在 ' + o.user_id + '（最終第 ' + (o.row + 1) + ' 列）';
    } else if(o.status === 'collision') {
        p.className = 'target warn';
        p.textContent = o.user_id + ' 已經被規則 ' + (o.kept_index + 1) +
            '（' + o.kept + '）用掉了 — 這張不會播。一隊只能一張, 把兩個獎項做成同一張圖。';
    } else {
        p.className = 'target warn';
        p.textContent = STATUS_TEXT[o.status] || o.status;
    }
}

function showPreview(box, rule) {
    if(!rule) return;
    var img = box.querySelector('.slide-image');
    var cap = box.querySelector('.slide-citation');
    var dir = (state.config.slides_dir || 'slides').replace(/\/*$/, '');
    cap.textContent = rule.citation || '';

    // 已知不存在的圖就不要發請求。每次編輯都會重跑預覽,
    // 對著缺圖硬打會變成每個按鍵數十個 404。
    var known = !state.imagesOk || state.images.indexOf(rule.image) !== -1;
    if(rule.image && known) {
        var src = dir + '/' + rule.image + '?v=' + (state.config.version || 1);
        if(img.getAttribute('src') !== src) img.setAttribute('src', src);
        img.hidden = false;
        img.onerror = function(){ img.hidden = true; };
    } else {
        img.hidden = true;
        img.removeAttribute('src');
        if(rule.image && !known) cap.textContent = (rule.citation || '') + '（找不到 ' + rule.image + '）';
    }
}

// ---------------------------------------------------------------------------
// 編輯
// ---------------------------------------------------------------------------

function ruleIndex(target) {
    var el = target.closest('.rule');
    return el ? Number(el.dataset.i) : -1;
}

function onFieldChange(e) {
    var f = e.target.dataset.f;
    if(!f) return;
    var i = ruleIndex(e.target);
    if(i < 0) return;
    var rule = state.config.rules[i];

    if(f === 'type') {
        rule.type = e.target.value;
        if(rule.type === 'rank') delete rule.problem; else delete rule.rank;
        render();   // 欄位組成變了, 必須重建
        return;
    } else if(f === 'rank' || f === 'problem') {
        var n = parseInt(e.target.value, 10);
        if(isNaN(n)) delete rule[f]; else rule[f] = n;
    } else if(f === 'image') {
        if(e.target.value) rule.image = e.target.value; else delete rule.image;
    } else if(f === 'citation') {
        rule.citation = e.target.value;
    }
    refresh();   // 不重建 DOM, 否則正在打字的輸入框會失焦
}

function onFilePick(e) {
    if(e.target.dataset.f !== 'upload') return;
    uploadImage(e.target.files && e.target.files[0], ruleIndex(e.target));
    e.target.value = '';
}

function onClick(e) {
    var act = e.target.dataset.act;
    if(!act) return;
    var i = ruleIndex(e.target);
    if(i < 0) return;
    var rules = state.config.rules;
    if(act === 'del') rules.splice(i, 1);
    else if(act === 'up' && i > 0) rules.splice(i - 1, 0, rules.splice(i, 1)[0]);
    else if(act === 'down' && i < rules.length - 1) rules.splice(i + 1, 0, rules.splice(i, 1)[0]);
    else return;
    render();
}

// ---------------------------------------------------------------------------
// 上傳與儲存 (只有連到 admin 埠時才可用)
// ---------------------------------------------------------------------------

function say(msg, bad) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status' + (bad ? ' bad' : '');
    if(!bad) setTimeout(function(){ if(el.textContent === msg) el.textContent = ''; }, 4000);
}

function uploadImage(file, ruleIdx) {
    if(!file) return;
    var name = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    say('上傳 ' + name + ' …');
    fetch('api/upload?name=' + encodeURIComponent(name), { method: 'POST', body: file })
        .then(function(res){ return res.json().then(function(j){ return { ok: res.ok, j: j }; }); })
        .then(function(r){
            if(!r.ok) throw new Error(r.j.error || '上傳失敗');
            state.images = r.j.images || state.images;
            if(ruleIdx >= 0) state.config.rules[ruleIdx].image = r.j.name;
            // 換了圖就要 bump version, 否則 Cloudflare 會繼續送同名的舊圖
            state.config.version = (parseInt(state.config.version, 10) || 1) + 1;
            document.getElementById('version').value = state.config.version;
            render();
            say('已上傳 ' + r.j.name + '，版本自動加到 ' + state.config.version);
        })
        .catch(function(err){ say(err.message, true); });
}

function saveSlides() {
    say('儲存中 …');
    fetch('api/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.config, null, 2)
    })
        .then(function(res){ return res.json().then(function(j){ return { ok: res.ok, j: j }; }); })
        .then(function(r){
            if(!r.ok) throw new Error(r.j.error || '儲存失敗');
            say('已寫入 slides.json（' + r.j.rules + ' 條規則），舊檔備份為 slides.json.bak');
        })
        .catch(function(err){ say(err.message, true); });
}

function download() {
    var json = JSON.stringify(state.config, null, 2) + '\n';
    var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'slides.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------

function fail(msg) {
    var p = document.getElementById('loaderr');
    p.textContent = msg;
    p.hidden = false;
    document.getElementById('summary').textContent = '';
}

loadJSON('contest.json')
    .then(function(contest){
        state.resolver = buildResolver(contest);
        // slides.json 可以不存在 -- 那就從空的開始
        return loadJSON('slides.json').catch(function(){ return defaultConfig(); });
    })
    .then(function(cfg){
        state.config = cfg && typeof cfg === 'object' ? cfg : defaultConfig();
        if(!Array.isArray(state.config.rules)) state.config.rules = [];
        return loadImages(state.config.slides_dir || 'slides');
    })
    .then(function(){
        document.getElementById('slides-dir').value = state.config.slides_dir || 'slides';
        document.getElementById('version').value = state.config.version || 1;
        document.getElementById('pre-freeze').checked =
            state.config.include_first_to_solve_before_freeze !== false;
        document.getElementById('download').disabled = false;
        document.getElementById('save').hidden = !state.canWrite;

        document.getElementById('rules').addEventListener('input', onFieldChange);
        document.getElementById('rules').addEventListener('change', onFieldChange);
        document.getElementById('rules').addEventListener('click', onClick);
        document.getElementById('rules').addEventListener('change', onFilePick);
        document.getElementById('save').addEventListener('click', saveSlides);
        document.getElementById('upload-any').addEventListener('change', function(e){
            uploadImage(e.target.files && e.target.files[0], -1);
            e.target.value = '';
        });
        // 只有連到 admin 埠(本機)才給寫入能力
        document.getElementById('writable').hidden = !state.canWrite;
        document.getElementById('readonly').hidden = state.canWrite;
        document.getElementById('add').addEventListener('click', function(){
            state.config.rules.push({ type: 'rank', rank: 1, image: '', citation: '' });
            render();
        });
        document.getElementById('download').addEventListener('click', download);
        document.getElementById('slides-dir').addEventListener('change', function(e){
            state.config.slides_dir = e.target.value.trim() || 'slides';
            loadImages(state.config.slides_dir).then(render);
        });
        document.getElementById('version').addEventListener('input', function(e){
            state.config.version = parseInt(e.target.value, 10) || 1;
            refresh();
        });
        document.getElementById('pre-freeze').addEventListener('change', function(e){
            state.config.include_first_to_solve_before_freeze = e.target.checked;
            refresh();
        });
        render();
    })
    .catch(function(err){
        fail('載不到資料: ' + err.message + '。請確認 contest.json 存在且伺服器正在跑。');
    });
