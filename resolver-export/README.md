# export_to_resolver.py

把 CMS 比賽的 submission 資料匯出、轉換成 [ioi-resolver](/home/dev/ioi-resolver) 用的 `contest.json`,並啟動開版器網頁。

執行方式:
```bash
/home/dev/.pyenv/versions/3.10.12/bin/python3.10 export_to_resolver.py <指令> --contest-id <id> [其他參數]
```

## 指令

### `dump`
從 CMS 資料庫撈出指定 contest 的 submission 資料,存成一份帶時間戳的備份資料夾(`exports/<contest>_<id>_<時間>/`),不會覆蓋舊備份。

### `convert`
把備份資料夾轉換成 `contest.json`,寫到 `ioi-resolver/contest.json`。不指定 `--from-backup` 時,會自動抓該 contest 最新的一份備份。

轉換時會做兩件過濾(備份本身保留完整原始資料,只有 `contest.json` 被過濾):

- **只保留比賽時間內的 submission**(`0 <= 距離開賽秒數 <= 比賽長度`)。CMS 在賽後仍然接受提交,賽前也有管理者的測試提交;這些如果留著,會因為落在凍結點之後而被 resolver 當成「待開版」的內容,開版時就會出現選手當場跳到滿分的假畫面。
- **hidden participation 標記為 `is_exclude`**,榜上仍看得到,但名次顯示為 `*`、不佔正式名次。

實際丟掉幾筆會寫在 log,也會記在 `contest.manifest.json` 的 `conversion_stats` 裡,可以拿來對帳。

### `serve`
在 `ioi-resolver` 目錄下開一個背景 HTTP server(預設 8899 port)。重複執行同一個 port 會直接重用;換 port 會自動關掉舊的再開新的。

### `all`(預設,不加指令名稱時就是這個)
依序執行 `dump` → `convert` → `serve`,一次做完全部。

## 常用參數

| 參數 | 說明 | 預設值 |
|---|---|---|
| `--contest-id` | 要處理的 contest id(必填) | — |
| `--exports-dir` | 備份存放位置 | 腳本所在目錄下的 `exports/` |
| `--resolver-dir` | ioi-resolver 目錄位置 | 腳本所在目錄的上一層 |
| `--freeze-minutes-before-end` | 賽制凍結時間(比賽結束前幾分鐘凍結榜單) | `60` |
| `--port` | server port | `8899` |
| `--dump-only` | (只用於 `all`)只做 dump,不轉換、不開 server | — |
| `--no-serve` | (只用於 `all`)做 dump+convert,但不啟動 server | — |
| `--from-backup` | (只用於 `convert`)指定要轉換哪份備份 | 自動抓最新 |

## 範例

```bash
# 一次做完:備份 + 轉換 + 開網頁
export_to_resolver.py --contest-id 2

# 只備份
export_to_resolver.py dump --contest-id 2

# 用某份舊備份重新轉換(例如改凍結時間)
export_to_resolver.py convert --contest-id 2 --freeze-minutes-before-end 30

# 換個 port 開網頁
export_to_resolver.py serve --port 9000
```

重新產生 `contest.json` 後,若瀏覽器已經開著舊的頁面,記得點「Reset standings」按鈕才會看到新資料。
