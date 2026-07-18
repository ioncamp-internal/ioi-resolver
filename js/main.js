/**
 *  main.js
 */


// Vuejs
function vuejs() {
      
    var RANKS_KEY = 'icpc-ranks';
    var OPER_FLAG_KEY = 'operation-flag';

    var OPEN_DELAY_TIME = 0;   //闪烁时间
    var FLY_DELAY_MS = 120;    // 翻轉完成到起飛之間的停頓, 讓觀眾看清楚成績
    // 等速上升: 時間正比於距離, 所有隊伍同一個速度。
    // 原本是固定時距, 導致移動 1 列跟移動 15 列花一樣久, 距離越遠看起來越快。
    var FLY_SPEED_PX_S = 600;  // 每秒移動的像素
    var FLY_MIN_MS = 250;      // 太短的移動仍要看得出來在動
    function flyDuration(distance) {
        return Math.max(FLY_MIN_MS, Math.abs(distance) / FLY_SPEED_PX_S * 1000);
    }
    window.Storage = {
        fetch: function(type) {
            if(type == 'ranks')
                return JSON.parse(localStorage.getItem(RANKS_KEY)) || window.resolver.rank_frozen;
            else if(type == 'opera_flag')
                return localStorage.getItem(OPER_FLAG_KEY) || 0;
        },

        update: function(type, data) {
            if(type == 'ranks')
                localStorage.setItem(RANKS_KEY, JSON.stringify(data));
            else if(type == 'opera_flag')
                localStorage.setItem(OPER_FLAG_KEY, data);
        }
    };

    // 依名次百分位決定翻轉速度(op.old_rank 為 0-based, 數字越大代表名次越後面):
    // 前 1%-25% 慢慢翻, 26%-50% 中速, 51%-100% 快速帶過
    var SPEED_TIERS = [
        { max_percentile: 0.25, multiplier: 1.6  }, // 前 25%: 慢速
        { max_percentile: 0.50, multiplier: 1.0  }, // 26%-50%: 中速
        { max_percentile: 1.0,  multiplier: 0.7  }  // 51%-100%: 快速
    ];
    // 一次 frozen submission 翻一次牌; multiplier 調整的是「每次翻多快」, 不是「翻幾次」。
    // 翻轉週期由 JS 寫進 inline style, css/main.css 的值只是 JS 失效時的後備。
    var FLIP_BASE_MS = 600;
    var FLIP_ACCEL   = 0.8; // 每翻一次就縮短為前一次的 8 成, 越翻越快
    var FLIP_MIN_MS  = 120; // 加速下限, 再快就看不出在翻了
    function getSpeedConfig(old_rank, total) {
        var percentile = (old_rank + 1) / total;
        for(var i = 0; i < SPEED_TIERS.length; i++) {
            if(percentile <= SPEED_TIERS[i].max_percentile)
                return SPEED_TIERS[i];
        }
        return SPEED_TIERS[SPEED_TIERS.length - 1];
    }

    var slide_shown_at = 0;
    var SLIDE_MIN_MS = 300;    // 投影片剛跳出的這段時間內忽略按鍵, 避免連按秒關

    // 名次定案的停頓: 每筆操作結束後, 這一批定案的隊伍會被逐一 focus。
    // 每隊都停, 不是只有拿獎的才停。按鍵前進 -- 有投影片就先出投影片, 再按才換下一隊。
    var settle_queue = [];
    var settle_idx = -1;

    function inSettleQueue() { return settle_idx >= 0; }

    function focusSettledTeam(user_id) {
        // 升幅超過一個螢幕高時, 飛行動畫是刻意讓該列飛出畫面上緣再靠重繪歸位
        // (見下方 distance 的處理), 所以這裡務必把它捲回視野正中央。
        var el_row = $('#rank-' + resolver.final_row[user_id]);
        $('.selected').removeClass('selected');
        el_row.addClass('selected');
        if(el_row.length) focusElement(el_row[0]);
    }

    // 移到這一批的下一隊; 整批處理完就把 highlight 還給下一個要翻的隊伍並放行
    function advanceSettleQueue() {
        settle_idx++;
        if(settle_idx < settle_queue.length) {
            focusSettledTeam(settle_queue[settle_idx]);
            return;
        }
        settle_queue = [];
        settle_idx = -1;
        $('.selected').removeClass('selected');
        if(vm.$data.op_flag < vm.$data.operations.length) {
            var op = vm.$data.operations[vm.$data.op_flag];
            $('#rank-' + op.old_rank).addClass('selected');
            centerSelected();
        }
        vm.$data.op_status = true;
    }

    function showSlide(slide) {
        vm.$data.slide_failed = false;
        vm.$data.slide = slide;
        slide_shown_at = Date.now();
    }

    // 兩條收尾路徑(原地不動 / 飛上去)共用的交棒動作。
    // 呼叫時該隊名次已定案, 所以這裡是掛頒獎投影片的正確時機。
    function finishOperation(op_index, el_old, problem_index) {
        var op_length = vm.$data.operations.length - 1;
        vm.selected(el_old, 'remove');
        if(vm.$data.op_flag < op_length) {
            var op_next = vm.$data.operations[vm.$data.op_flag + 1];
            vm.selected($('#rank-' + op_next.old_rank), 'add');
        }
        el_old.find('.p-' + problem_index).removeClass('uncover');
        vm.$data.op_flag += 1;

        var settling = resolver.settle_by_op[op_index];
        if(settling && settling.length) {
            // op_status 保持 false: 整批 focus 走完之前都不接受推進揭曉
            settle_queue = settling;
            settle_idx = -1;
            advanceSettleQueue();
        } else {
            centerSelected();   // 下一隊先就定位, 按鍵時直接開翻
            vm.$data.op_status = true;
        }
    }

    window.Operation = {
        inSettleQueue: inSettleQueue,

        // 名次定案停頓中的按鍵: 先出投影片, 再按才換下一隊。太快按會被忽略。
        settleStep: function() {
            if(vm.$data.slide) {
                if(Date.now() - slide_shown_at < SLIDE_MIN_MS) return;
                vm.$data.slide = null;
                advanceSettleQueue();
                return;
            }
            var slide = resolver.slides_by_team[settle_queue[settle_idx]];
            if(slide) showSlide(slide);
            else advanceSettleQueue();
        },

        next: async function() {
            vm.$data.op_status = false;
            var op_index = vm.$data.op_flag;
            var op = vm.$data.operations[vm.$data.op_flag];
            var op_length = vm.$data.operations.length - 1;
            if(vm.$data.op_flag < op_length)
                var op_next = vm.$data.operations[vm.$data.op_flag+1];
            var ranks = vm.$data.ranks;
            var rank_old = ranks[op.old_rank];
            var speed_cfg = getSpeedConfig(op.old_rank, ranks.length);
            var speed_mult = speed_cfg.multiplier;

            var el_old = $('#rank-' + op.old_rank);
            var el_new = $('#rank-' + op.new_rank);

            // Rotate: 翻的次數等於封榜後的提交次數, 且一次比一次快。
            // 每圈都是完整 360 度, 所以逐圈重啟動畫在視覺上是連續的。
            var flip_count = Math.max(1, parseInt(op.frozen_submissions) || 0);
            var flip_duration = FLIP_BASE_MS * speed_mult;
            var el_flip = el_old.find('.p-'+op.problem_index).find('.p-content');
            el_flip.addClass('uncover');
            for(var f = 0; f < flip_count; f++) {
                // 先關掉 animation-name 再開, 中間強制 reflow, 這樣新的週期才會從 0 度重跑
                el_flip.css({'animation-name': 'none', '-webkit-animation-name': 'none'});
                el_flip[0].offsetWidth;
                el_flip.css({
                    'animation-duration': flip_duration+'ms', '-webkit-animation-duration': flip_duration+'ms',
                    'animation-name': 'rotating', '-webkit-animation-name': 'rotating'
                });
                await sleep(flip_duration);
                flip_duration = Math.max(FLIP_MIN_MS, flip_duration * FLIP_ACCEL);
            }
            el_flip
                .removeClass('uncover')
                .css({
                    'animation-duration': '', '-webkit-animation-duration': '',
                    'animation-name': '', '-webkit-animation-name': ''
                });

            if(op.new_rank == op.old_rank){
                setTimeout(function(){
                    var ver = op.new_verdict;
                    if(ver == 'AC'){
                        num = 100;
                        var ver2 = op.old_verdict;
                        if (ver2[0] == 'P') {
                            var num2 = parseInt(ver2.substring(1, ver2.length));
                            num -= num2;
                        }
                        rank_old.score += num;
                    }else if (ver[0] == 'P') {
                        var num = parseInt(ver.substring(1, ver.length));
                        var ver2 = rank_old.problem[op.problem_index].old_verdict;
                        if (ver2[0] == 'P') {
                            var num2 = parseInt(ver2.substring(1, ver2.length));
                            var mx = max(num, num2);
                            op.new_verdict = "P" + mx.toString();
                            if (num > num2)
                                num -= num2;
                            else
                                num = 0;
                        }
                        rank_old.score += num;
                    }
                    rank_old.problem[op.problem_index].old_verdict = op.new_verdict;
                    rank_old.problem[op.problem_index].new_verdict = "NA";

                    if(op.new_verdict == 'AC'){
                        rank_old.problem[op.problem_index].old_submissions = op.new_submissions;
                        rank_old.problem[op.problem_index].frozen_submissions = 0;
                        rank_old.problem[op.problem_index].new_submissions = 0;
                    }
                    else {
                        rank_old.problem[op.problem_index].old_submissions +=  op.frozen_submissions;
                        rank_old.problem[op.problem_index].frozen_submissions = 0;
                        rank_old.problem[op.problem_index].new_submissions = 0;
                    }
                    Vue.nextTick(setRank);

                    setTimeout(function(){
                        finishOperation(op_index, el_old, op.problem_index);
                    }, FLY_DELAY_MS);   // 沒有飛行, 但停頓保持一致
                }, OPEN_DELAY_TIME);
            }else{
                var old_pos_top = el_old.position().top;
                var new_pos_top = el_new.position().top;
                var distance = new_pos_top - old_pos_top;
                var win_heigth = $(window).height();
                if(Math.abs(distance) > win_heigth){
                    distance = -(win_heigth + 100);
                }
                var j = op.old_rank - 1;
                var el_obj = [];
                for(j; j >= op.new_rank; j--){
                    var el = $('#rank-'+ j);
                    el.rank_obj = ranks[j];
                    el_obj.push(el);
                }
                setTimeout(function(){
                        // 修改原始数据
                        var ver = op.new_verdict;
                        if(op.new_verdict == 'AC'){
                            num = 100;
                            var ver2 = op.old_verdict;
                            if (ver2[0] == 'P') {
                                var num2 = parseInt(ver2.substring(1, ver2.length));
                                num -= num2;
                            }
                            rank_old.score += num;
                            rank_old.rank_show = op.new_rank_show;
                        }else if (ver[0] == 'P') {
                            var num = parseInt(ver.substring(1, ver.length));
                            var ver2 = rank_old.problem[op.problem_index].old_verdict;
                            if (ver2[0] == 'P') {
                                var num2 = parseInt(ver2.substring(1, ver2.length));
                                var mx = max(num, num2);
                                op.new_verdict = "P" + mx.toString();
                                if (num > num2)
                                    num -= num2;
                                else
                                    num = 0;
                            }
                            rank_old.score += num;
                        }
                        rank_old.problem[op.problem_index].old_verdict = op.new_verdict;
                        rank_old.problem[op.problem_index].new_verdict = "NA";

                        if(op.new_verdict == 'AC'){
                            rank_old.problem[op.problem_index].old_submissions = op.new_submissions;
                            rank_old.problem[op.problem_index].frozen_submissions = 0;
                            rank_old.problem[op.problem_index].new_submissions = 0;
                        }
                        else {
                            rank_old.problem[op.problem_index].old_submissions +=  op.frozen_submissions;
                            rank_old.problem[op.problem_index].frozen_submissions = 0;
                            rank_old.problem[op.problem_index].new_submissions = 0;
                        }
                        Vue.nextTick(function(){
                            //修改排名
                            el_old.find('.rank').text(op.new_rank_show);
                            el_obj.forEach(function(val,i){ 
                                var dom_rank = el_obj[i].find('.rank');
                                var dom_rank_old = el_old.find('.rank');
                                if (dom_rank.text() !== "*" && dom_rank_old.text() !== "*") {
                                    var new_rank_show = Number(dom_rank.text())+1;
                                    dom_rank.text(new_rank_show);
                                    el_obj[i].rank_obj.rank_show = new_rank_show; 
                                }
                            });
                        });

                    setTimeout(function(){
                        el_old
                            .css('position', 'relative')
                            .animate({ top: distance+'px' }, flyDuration(distance), function(){
                                el_new.removeAttr('style');
                                el_old.removeAttr('style');
                                var ranks_tmp = $.extend(true, [], ranks);
                                var data_old = ranks_tmp[op.old_rank];
                                var i = op.old_rank - 1;
                                for(i; i >= op.new_rank; i--){
                                    ranks_tmp[i+1] = ranks_tmp[i];
                                }
                                ranks_tmp[op.new_rank] = data_old;
                                vm.$set('ranks', ranks_tmp);

                                Vue.nextTick(function () {
                                    el_obj.forEach(function(val,i){ el_obj[i].removeAttr('style'); });
                                    finishOperation(op_index, el_old, op.problem_index);
                                });
                                Vue.nextTick(setRank);
                            });
                        // 被擠下來的列只移動一格, 用同一個速度算它自己的時間
                        for(var i = 0 ; i<el_obj.length ; ++i) {
                            if(106*(i-1)<=win_heigth){
                                el_obj[i].animate({'top': 106+'px'}, flyDuration(106));
                            }
                            else {
                                el_obj[i].css({'top': 106+'px'});
                            }
                        }
                    }, FLY_DELAY_MS);
                }, OPEN_DELAY_TIME);
            }
        }
    };
    
    Vue.filter('problemStatus', function (problem) {
        return resolver.status(problem);
    });
    
    Vue.filter('submissions', function (problem) {
        var st = resolver.status(problem);
        if(st == 'ac')
            return 100;
        else if(st == 'frozen') {
            var ver = problem.old_verdict;
            var num = parseInt(ver.substring(1, ver.length));
            num = num.toString();
            if (isNaN(num))
                num = '0';
            return `${num}+[${problem.frozen_submissions}]`;
        }
        else if(st == 'failed') {
            var ver = problem.old_verdict;
            var num = parseInt(ver.substring(1, ver.length));
            return num;
        }
        else 
            return 'untouched';
        // todo
    });

    window.vm = new Vue({
        el: '.app',

        data: {
            op_flag: Number(Storage.fetch('opera_flag')),
            op_status: true,  // running: false, stop: true
            p_count: resolver.problem_count,
            ranks: Storage.fetch('ranks'),
            operations: resolver.operations,
            users: resolver.users,
            slide: null,       // 目前顯示的頒獎投影片, null 代表沒有
            slide_failed: false // 圖片載不到 -> 只顯示 citation 文字
        },

        ready: function () {
            this.$watch('ranks', function(ranks){
                Storage.update('ranks', ranks);
            }, {'deep': true});

            this.$watch('op_flag', function(op_flag){
                Storage.update('opera_flag', op_flag);
            }, {'deep': true});

            if(this.op_flag < this.operations.length){
                var op = this.operations[this.op_flag];
                this.selected($('#rank-'+op.old_rank), 'add');
                Vue.nextTick(centerSelected);   // 一開場第一隊就在中央
            }
        },

        methods: {
            reset: function(){
                if(confirm('Reset standings?')){    
                    localStorage.clear();
                    window.location.reload();
                }
            },

            selected: function(el, type){
                if(type == 'add'){
                    el.addClass('selected');
                }else if(type == 'remove')
                    el.removeClass('selected');
            },

            // 圖片還沒做好或路徑錯 -> 退回只顯示 citation 文字, 不要破圖
            slideFailed: function(){
                console.warn('slides: image not found, falling back to citation text');
                this.slide_failed = true;
            }
        }
    });
}

$.getJSON("contest.json", function(data){
    var resolver = new Resolver(data.solutions, data.users, data.problem_count, data.frozen_second);
    window.resolver = resolver;
    resolver.calcOperations();
    resolver.buildSettleQueue();   // 定案停頓與投影片無關, 沒有 slides.json 也要有

    // slides.json 是選配: 載不到或壞掉就照常揭曉, 只是不播投影片
    $.getJSON("slides.json")
        .done(function(cfg){ resolver.resolveSlides(cfg); })
        .fail(function(){ console.warn('slides: slides.json unavailable, running without slides'); })
        .always(start);

    function start(){
        vuejs();

        document.onkeydown = function(event){
            var e = event || window.event || arguments.callee.caller.arguments[0];
            if(!e) return;
            var advance = (e.keyCode == 39 || e.keyCode == 32); // 右鍵 / 空白鍵

            // 名次定案的停頓中(含投影片顯示中): 按鍵只在這個停頓內前進, 不推進揭曉
            if(Operation.inSettleQueue()){
                if(advance){
                    e.preventDefault();  // 空白鍵預設會捲動頁面
                    Operation.settleStep();
                }
                return;
            }

            if(advance && vm.$data.op_status){
                e.preventDefault();
                centerSelected();   // 保險: 正常情況下上一筆收尾時已經置中了
                Operation.next();
            }
            if(e.keyCode == 13) {
                centerSelected();
            }
        };
    }
});

function focusElement(elem) {
    if(elem) elem.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
// 正在翻牌的隊伍固定停在畫面正中央
function centerSelected() {
    focusElement(document.getElementsByClassName('selected')[0]);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function setRank() {
    // Same score => same rank
    var user_cnt = vm.$data.ranks.length;
    for (var i = 1; i < user_cnt; i++) {
        var now = $('#rank-'+ i.toString());
        var prev = $('#rank-'+ (i - 1).toString());
        if (now.find('.solved').text() == prev.find('.solved').text()) {
            now.find('.rank').text(prev.find('.rank').text());
        }
    }
}
