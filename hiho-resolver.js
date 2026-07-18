function Resolver(solutions, users, problem_count, frozen_second){
	this.solutions = solutions;
	this.users = users;
	this.problem_count = problem_count;
	this.frozen_seconds = frozen_second;
	this.operations = [];
	this.slides_by_team = {};   // slides.json 載不到時就維持空的
	this.settle_by_op = {};
	this.final_row = {};
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

	var settled = {}, final_row = {}, order = [], u;
	for(k = 0; k < pos.length; k++) { final_row[pos[k]] = k; order.push(pos[k]); }
	for(k = 0; k < pos.length; k++) {
		u = pos[k];
		// 兩者皆無 = 從頭到尾沒動過也沒翻過牌, 沒有可供停頓的操作
		if(own[u] === undefined && moved[u] === undefined) continue;
		if(own[u] === undefined)        settled[u] = moved[u];
		else if(moved[u] === undefined) settled[u] = own[u];
		else                            settled[u] = max(own[u], moved[u]);
	}
	return { settled: settled, final_row: final_row, order: order };
};

// 每筆操作結束後有哪些隊伍的名次就此定案 -- 揭曉會在那裡停下來, 逐一 focus 他們。
// 一筆操作常同時讓多隊定案(實測 25 隊只有 16 個相異定案點), 所以是陣列;
// 由下往上排(列索引大的先), 跟揭曉方向一致。
Resolver.prototype.buildSettleQueue = function() {
	var pts = this.settlePoints();
	this.final_row = pts.final_row;
	this.settle_order = pts.order;
	this.settle_by_op = {};

	for(var u in pts.settled) {
		var j = pts.settled[u];
		if(!this.settle_by_op[j]) this.settle_by_op[j] = [];
		this.settle_by_op[j].push(u);
	}
	var rows = pts.final_row;
	for(var op in this.settle_by_op)
		this.settle_by_op[op].sort(function(a, b){ return rows[b] - rows[a]; });
	return this.settle_by_op;
};

// 把 slides.json 的規則解析成 { user_id: 投影片 }。
// 綁在隊伍身上而不是操作上 -- 揭曉本來就會在每隊定案時停下來 focus 他們(見
// buildSettleQueue), 投影片只是接在那次 focus 之後。同一筆操作讓多隊定案時,
// 每隊仍各自擁有自己的投影片。必須在 buildSettleQueue() 之後呼叫。
Resolver.prototype.resolveSlides = function(config) {
	this.slides_by_team = {};
	if(!config) return this.slides_by_team;
	if(!Array.isArray(config.rules)) {
		if(config.rules) console.warn('slides: "rules" must be an array, ignoring config');
		return this.slides_by_team;
	}

	var i, fts = this.firstToSolve();
	var version = config.version || 1;
	var dir = (config.slides_dir || 'slides').replace(/\/+$/, '');
	var allow_pre_freeze = config.include_first_to_solve_before_freeze !== false;
	// 同一隊被多條規則指到, 只能留一張。掛在 this 上讓 admin.html 讀得到 --
	// 揭曉端只把它印到 console, 設定頁需要把它顯示出來。
	var collisions = this.collisions = [];
	// 每條規則的結果, 供設定頁逐條顯示落在誰身上或為什麼沒播
	var outcomes = this.rule_outcomes = [];
	function outcome(index, why, status, extra) {
		var o = { index: index, why: why, status: status };
		for(var k in (extra || {})) o[k] = extra[k];
		outcomes.push(o);
		return o;
	}

	for(var r = 0; r < config.rules.length; r++) {
		var rule = config.rules[r], user_id = null, why;
		if(!rule || (!rule.image && !rule.citation)) {
			console.warn('slides: rule ' + r + ' has neither image nor citation, skipped');
			outcome(r, 'rule ' + r, 'empty');
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
			outcome(r, 'rule ' + r, 'unknown-type');
			continue;
		}

		if(!user_id) {
			console.warn('slides: no team matched ' + why + ', skipped');
			outcome(r, why, 'unmatched');
			continue;
		}
		if(this.final_row[user_id] === undefined) {
			console.warn('slides: ' + user_id + ' never settles, cannot show ' + why);
			outcome(r, why, 'never-settles', { user_id: user_id });
			continue;
		}
		if(this.slides_by_team[user_id]) {
			collisions.push({ kept: this.slides_by_team[user_id].why, dropped: why, team: user_id });
			outcome(r, why, 'collision', {
				user_id: user_id,
				kept: this.slides_by_team[user_id].why,
				kept_index: this.slides_by_team[user_id].rule_index
			});
			continue;
		}
		outcome(r, why, 'ok', { user_id: user_id, row: this.final_row[user_id] });
		this.slides_by_team[user_id] = {
			rule_index: r,
			image_url: rule.image ? (dir + '/' + rule.image + '?v=' + version) : '',
			citation: rule.citation || '',
			why: why,
			user_id: user_id,
			row: this.final_row[user_id]   // focus 時要捲到的那一列
		};
	}

	this.reportSlides(collisions);
	return this.slides_by_team;
};

// 載入時把排程印出來: 每隊定案於哪一筆操作、有沒有投影片。
// 一隊只能有一張投影片, 所以被同一隊的多條規則指到時會捨棄後者。
Resolver.prototype.reportSlides = function(collisions) {
	var ops = Object.keys(this.settle_by_op).map(Number).sort(function(a,b){ return a-b; });
	var n = 0, i, k;
	for(i = 0; i < ops.length; i++) n += this.settle_by_op[ops[i]].length;
	console.log('slides: ' + n + ' team(s) settle across ' + ops.length +
	            ' stop(s) in ' + this.operations.length + ' operations');
	for(i = 0; i < ops.length; i++) {
		var teams = this.settle_by_op[ops[i]];
		for(k = 0; k < teams.length; k++) {
			var s = this.slides_by_team[teams[k]];
			console.log('  op ' + ops[i] + '  row ' + this.final_row[teams[k]] + '  ' +
			            teams[k] + (s ? '  -> ' + s.why : ''));
		}
	}
	if(!collisions || !collisions.length) return;
	console.warn('slides: ' + collisions.length + ' rule(s) dropped -- a team can only show one ' +
	             'slide. Put the awards on one image and delete the losing rule, or reorder ' +
	             '"rules" to change which one wins:');
	for(i = 0; i < collisions.length; i++) {
		var c = collisions[i];
		console.warn('  ' + c.team + '  kept "' + c.kept + '"  dropped "' + c.dropped + '"');
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
