# 頒獎投影片

把圖片放進這個目錄，檔名對應 `../slides.json` 裡的 `image` 欄位。

- 格式：PNG / JPG，任何解析度都可以（會等比縮放塞滿畫面，不裁切）
- **圖片還沒做好也能跑**：找不到圖片時會退回顯示 `citation` 文字，不會出現破圖
- **換圖之後記得 bump `slides.json` 的 `version`**，否則 Cloudflare 會繼續送舊圖（邊緣快取 4 小時）

## 觸發時機

投影片綁在隊伍身上，在該隊**升到最終名次之後**播放，跟 ICPC Resolver 一致。
按右鍵或空白鍵關閉，關掉才會接續下一隊。

- `type: "rank"` → 最終名次為 `rank` 的隊伍
- `type: "first-to-solve"` → 該題最早 AC 的隊伍（依真實提交時間）

`include_first_to_solve_before_freeze` 控制封榜前就拿下的一血要不要播。設 `false`
就只播揭曉過程中才出現的那些。

一個觸發點只會播一張。若兩條規則指到同一隊（例如冠軍剛好也是某題一血），
排在 `rules` 前面的優先，被蓋掉的那條會在 console 留警告。
