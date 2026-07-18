function Resolver(solutions, users, problem_count, frozen_second){
	this.solutions = solutions;
	this.users = users;
	this.problem_count = problem_count;
	this.frozen_seconds = frozen_second;
	this.operations = [];
	this.slides_by_op = {};
}

// 每題最早的 AC(依真實提交時間), 也就是一血。排除 is_exclude 帳號 --
// 匯出端已經濾掉了, 這裡再擋一次是為了舊的 contest.json 也不會誤判。
Resolver.prototype.firstToSolve = function() {
	var best = {};
	for(var id in this.solutions) {
		var s = this.solutions[id];
		if(s.verdict !== 'AC') continue;
		var u = this.users[s.user_id];
		if(!u || u.is_exclude === true) continue;
		var cur = best[s.problem_index];
		if(!cur || s.submitted_seconds < cur.seconds)
			best[s.problem_index] = { user_id: s.user_id, seconds: s.submitted_seconds };
	}
	return best;
};

// 重播 operations, 算出每隊「名次真正定案」的那一筆操作與最終列索引。
//
// 不能只看該隊自己最後一次翻牌: 揭曉並非嚴格由低到高逐隊收斂, 一支隊伍升上去之後,
// 仍會被後面才解析的隊伍超越而被擠下來(實測 7 支裡有 5 支如此, 最多相差 14 個操作)。
// 定案時間點 = max(自己最後一次翻牌, 最後一次被移動)。
Resolver.prototype.settlePoints = function() {
	var i, j, k, pos = [];
	for(i = 0; i < this.rank_frozen.length; i++) pos.push(this.rank_frozen[i].user_id);

	var own = {}, moved = {};
	for(j = 0; j < this.operations.length; j++) {
		var op = this.operations[j];
		own[op.user_id] = j;
		if(op.new_rank === op.old_rank) continue;

		var before = {};
		for(k = 0; k < pos.length; k++) before[pos[k]] = k;
		pos.splice(op.new_rank, 0, pos.splice(op.old_rank, 1)[0]);
		for(k = 0; k < pos.length; k++)
			if(before[pos[k]] !== k) moved[pos[k]] = j;
	}

	var settled = {}, final_row = {}, order = [];
	for(k = 0; k < pos.length; k++) { final_row[pos[k]] = k; order.push(pos[k]); }
	for(var u in own)
		settled[u] = (moved[u] === undefined) ? own[u] : max(own[u], moved[u]);
	return { settled: settled, final_row: final_row, order: order };
};

// 把 slides.json 的規則解析成 { 操作索引: 投影片 }。
// 錨點是該隊名次定案的那一筆操作(見 settlePoints)。必須在 calcOperations() 之後呼叫。
Resolver.prototype.resolveSlides = function(config) {
	this.slides_by_op = {};
	if(!config) return this.slides_by_op;
	if(!Array.isArray(config.rules)) {
		if(config.rules) console.warn('slides: "rules" must be an array, ignoring config');
		return this.slides_by_op;
	}

	var pts = this.settlePoints();
	var settled = pts.settled, order = pts.order;

	function anchorFor(user_id) {
		if(settled[user_id] !== undefined) return settled[user_id];
		// 該隊完全沒有封榜提交 -> 沒有自己的翻牌事件。
		// 退而求其次掛在名次緊鄰其下、且有事件的隊伍, 等於揭曉經過他們時播放。
		for(var j = order.indexOf(user_id) + 1; j < order.length; j++)
			if(settled[order[j]] !== undefined) return settled[order[j]];
		return -1;
	}

	var fts = this.firstToSolve();
	var version = config.version || 1;
	var dir = (config.slides_dir || 'slides').replace(/\/+$/, '');
	var allow_pre_freeze = config.include_first_to_solve_before_freeze !== false;
	var collisions = [];   // 撞點被捨棄的規則, 最後統一報告

	for(var r = 0; r < config.rules.length; r++) {
		var rule = config.rules[r], user_id = null, why;
		if(!rule || (!rule.image && !rule.citation)) {
			console.warn('slides: rule ' + r + ' has neither image nor citation, skipped');
			continue;
		}

		if(rule.type === 'rank') {
			why = 'rank ' + rule.rank;
			for(i = 0; i < this.rank2.length; i++)
				if(this.rank2[i].rank_show === rule.rank) { user_id = this.rank2[i].user_id; break; }
		} else if(rule.type === 'first-to-solve') {
			why = 'first-to-solve p' + rule.problem;
			var hit = fts[rule.problem];
			if(hit && (allow_pre_freeze || hit.seconds > this.frozen_seconds))
				user_id = hit.user_id;
		} else {
			console.warn('slides: unknown rule type ' + rule.type + ', skipped');
			continue;
		}

		if(!user_id) { console.warn('slides: no team matched ' + why + ', skipped'); continue; }
		var op = anchorFor(user_id);
		if(op < 0) { console.warn('slides: no operation to anchor ' + why + ' to, skipped'); continue; }
		if(this.slides_by_op[op]) {
			collisions.push({ op: op, kept: this.slides_by_op[op].why, dropped: why, team: user_id });
			continue;
		}
		this.slides_by_op[op] = {
			image_url: rule.image ? (dir + '/' + rule.image + '?v=' + version) : '',
			citation: rule.citation || '',
			why: why,
			user_id: user_id,
			row: pts.final_row[user_id]   // 切投影片前要把這一列捲回視野
		};
	}

	this.reportSlides(collisions);
	return this.slides_by_op;
};

// 載入時把結果印出來。撞點的規則會被捨棄(一個定案點只播一張), 這份報告就是
// 用來告訴你「哪幾個獎項該合併成同一張圖」-- 一次操作常同時讓多隊定案,
// 實測 25 隊只有 16 個相異定案點, 所以撞點是常態而非例外。
Resolver.prototype.reportSlides = function(collisions) {
	var ops = Object.keys(this.slides_by_op).map(Number).sort(function(a,b){ return a-b; });
	console.log('slides: ' + ops.length + ' slide(s) scheduled across ' +
	            this.operations.length + ' operations');
	for(var i = 0; i < ops.length; i++) {
		var s = this.slides_by_op[ops[i]];
		console.log('  op ' + ops[i] + '  row ' + s.row + '  ' + s.why + '  (' + s.user_id + ')');
	}
	if(!collisions || !collisions.length) return;
	console.warn('slides: ' + collisions.length + ' rule(s) dropped -- these teams settle at the ' +
	             'same operation as an earlier rule. Put the awards on one image and delete the ' +
	             'losing rule, or reorder "rules" to change which one wins:');
	for(i = 0; i < collisions.length; i++) {
		var c = collisions[i];
		console.warn('  op ' + c.op + '  kept "' + c.kept + '"  dropped "' + c.dropped +
		             '"  (' + c.team + ')');
	}
};

Resolver.prototype.status = function(problem) {
	if(problem.old_verdict == 'NA' && problem.new_verdict == 'NA')
		return "untouched";
	else if(problem.old_verdict == 'AC')
		return "ac";
	else if(problem.new_verdict == 'NA')
		return "failed";
	else 
		return "frozen";
}
function max(a, b) {
    return a > b ? a : b;
}
Resolver.prototype.calcOperations = async function() {
	this.rank = {};
	for(var solution_id in this.solutions) {
		var sol = this.solutions[solution_id];
		if(['WT', 'CE', 'VE', 'SE'].indexOf(sol.verdict) != -1) {
			continue;
		}
		if(Object.keys(this.rank).indexOf(sol.user_id) == -1) {
			this.rank[sol.user_id] = {'score':0, 'user_id':sol.user_id};
			this.rank[sol.user_id].problem = {};
			for(var i = 1; i <= this.problem_count; i++) {
				this.rank[sol.user_id].problem[i] = {
					'old_verdict':'NA',
					'new_verdict':'NA',
					'old_submissions':0,	//include the AC submission
					'frozen_submissions': 0,
					'new_submissions':0
				};
			}
		}
		
		if(this.rank[sol.user_id].problem[sol.problem_index].old_verdict=='AC') {
			continue;
		}
		if(sol.submitted_seconds <= this.frozen_seconds) {
            var ver = sol.verdict;
			if(ver == 'AC') {
				this.rank[sol.user_id].problem[sol.problem_index].old_submissions++;
                var num = 100;

                ver = this.rank[sol.user_id].problem[sol.problem_index].old_verdict;
                if (ver[0] == 'P') {
                    var num2 = parseInt(ver.substring(1, ver.length));
                    num -= num2;
                }
				this.rank[sol.user_id].score += num;
            }else if (ver[0] == 'P') {
                var num = parseInt(ver.substring(1, ver.length));
                ver = this.rank[sol.user_id].problem[sol.problem_index].old_verdict;
                if (ver[0] == 'P') {
                    var num2 = parseInt(ver.substring(1, ver.length));
                    var mx = max(num, num2);
                    sol.verdict = String('P' + mx.toString());
                    if (num > num2)
                        num -= num2;
                    else
                        num = 0;
                }
                this.rank[sol.user_id].score += num;
            }else {
				this.rank[sol.user_id].problem[sol.problem_index].old_submissions++;
			}
			this.rank[sol.user_id].problem[sol.problem_index].old_verdict = sol.verdict;
		}
		else {    //after standings get frozen    
            if(this.rank[sol.user_id].problem[sol.problem_index].new_verdict=='AC') {
                this.rank[sol.user_id].problem[sol.problem_index].frozen_submissions++;
                continue;
            }
            if(sol.verdict == 'AC') {
                this.rank[sol.user_id].problem[sol.problem_index].new_verdict = sol.verdict;
                this.rank[sol.user_id].problem[sol.problem_index].frozen_submissions++;
                this.rank[sol.user_id].problem[sol.problem_index].new_submissions = this.rank[sol.user_id].problem[sol.problem_index].old_submissions + this.rank[sol.user_id].problem[sol.problem_index].frozen_submissions;
            }
            else {
                var old = this.rank[sol.user_id].problem[sol.problem_index].new_verdict;
                var tmp = sol.verdict;
                if (old[0] == 'P') {
                    var num1 = parseInt(old.substring(1, old.length));
                    var num2 = parseInt(sol.verdict.substring(1, sol.verdict.length));
                    var mx = max(num1, num2);
                    tmp = String('P' + mx.toString());
                }
                this.rank[sol.user_id].problem[sol.problem_index].new_verdict = tmp;
                this.rank[sol.user_id].problem[sol.problem_index].frozen_submissions++;
            }
        }
	}
	var uids = Object.keys(this.rank);
	this.rank2 = [];
	for(var key in uids) {
		var user_id = uids[key];
		this.rank2.push(this.rank[user_id]);
	}
	this.rank2.sort(function(a, b){
		return b.score - a.score;
	});
	var rnk = 0;
	for (var i = 0; i < this.rank2.length; ++i) {
		var user_id = this.rank2[i].user_id;
		if (this.users[user_id].is_exclude === true) {
			this.rank2[i].rank_show = "*";
			this.rank[user_id].rank_show = "*";
		} else {
			rnk++;
			this.rank2[i].rank_show = rnk;
			this.rank[user_id].rank_show = rnk;
		}
	}
	this.rank_frozen = $.extend(true, [], this.rank2);
	for(var i = this.rank2.length - 1; i >= 0; i--) {
		var flag = true;
		while(flag) {
			flag = false;
			for(var j = 1; j <= this.problem_count; j++) {
				if(this.status(this.rank2[i].problem[j]) == "frozen") {
					flag = true;
					var op = {
						id: this.operations.length, 
						user_id: this.rank2[i].user_id,
						problem_index: j,
      					old_verdict: this.rank2[i].problem[j].old_verdict,
						new_verdict: this.rank2[i].problem[j].new_verdict,
						old_submissions: this.rank2[i].problem[j].old_submissions,
						frozen_submissions: this.rank2[i].problem[j].frozen_submissions,
						new_submissions: this.rank2[i].problem[j].new_submissions,
						old_rank: i,
						new_rank: -1,
						old_rank_show: this.rank2[i].rank_show,
						new_rank_show: -1
					};
					var tmp = this.rank2[i];
                    var ver = tmp.problem[j].new_verdict;
					if(ver == 'AC') {
                        var num = 100;
                        var ver2 = tmp.problem[j].old_verdict;
                        if (ver2[0] == 'P') {
                            var num2 = parseInt(ver2.substring(1, ver2.length));
                            num -= num2;
                        }
						tmp.score += num;
                    }else if (ver[0] == 'P') {
                        var num = parseInt(ver.substring(1, ver.length));
                        var ver2 = tmp.problem[j].old_verdict;
                        if (ver2[0] == 'P') {
                            var num2 = parseInt(ver2.substring(1, ver2.length));
                            var mx = max(num, num2);
                            ver = "P" + mx.toString();
                            if (num > num2)
                                num -= num2;
                            else
                                num = 0;
                        }
                        tmp.score += num;
                    }
					tmp.problem[j].old_verdict = ver;
					tmp.problem[j].new_verdict = "NA";
					var k = i -1;
					while(k >= 0 && this.rank2[k].score < tmp.score) {
						if (tmp.rank_show !== "*" && this.rank2[k].rank_show !== "*") {
							tmp.rank_show--;
							this.rank2[k].rank_show++;
						}
						this.rank2[k+1] = this.rank2[k];
						k--;
					}
					this.rank2[k+1] = tmp;
					op.new_rank = k+1;
					op.new_rank_show = tmp.rank_show;
					this.operations.push(op);
					break;
				}
			}
		}
	}
    await sleep(100);
    var user_cnt = this.rank2.length;
    for (var i = 1; i < user_cnt; i++) {
        var now = $('#rank-'+ i.toString());
        var prev = $('#rank-'+ (i - 1).toString());
        if (now.find('.solved').text() == prev.find('.solved').text()) {
            now.find('.rank').text(prev.find('.rank').text());
        }
    }
}
