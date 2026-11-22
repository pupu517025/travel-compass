# 旅遊不卡卡：台灣即時活動

完整功能、使用方式與目前限制請先看[功能說明.md](功能說明.md)。

此專案以活動資料為唯一推薦來源，不含常駐景點清單。前端會在載入時只保留 `status === "Approved"` 且 `end_date >= 今日` 的活動。

手機網站部署和雲端管理者設定請看[部署手機網站.md](部署手機網站.md)。

## 設定雲端資料來源

前端預設讀取 `data/tourism-events.json`。同步後把該檔提供在網站可讀取的位置；也可在部署頁面覆寫 API URL：

```html
<script>window.EVENTS_API_URL = "https://your-events-endpoint.example/events.json";</script>
```

URL 可回傳 JSON 陣列、`{ "records": [...] }`、`{ "events": [...] }`、`{ "data": [...] }`，或 Google Sheets 發布的 CSV。Airtable 回應的 `records[].fields` 也會解析。瀏覽器須能連線到該 URL 並允許 CORS；不要將 Airtable 私密 token 放在前端，正式部署請以後端代理保管憑證。讀取失敗時會自動載入開發 Mock Events。

## 同步觀光署公開活動資料

`scripts/sync-tourism-events.mjs` 會下載觀光署每日更新的官方活動 JSON 壓縮檔，轉成 App schema、過濾已結束／取消／缺少座標的項目，並以 `EventID` 去重。新活動及來源內容有變更的活動會標為 `Pending`；未變更的管理者審核狀態會保留。年份會依開始日期加到活動名稱前。

```powershell
node scripts/sync-tourism-events.mjs
```

在可連線的部署環境中，將此命令排程每日執行。同步後檢視 `data/tourism-events.json`，把確認上架的紀錄 `status` 設為 `Approved`，再部署 JSON 檔。前端仍只顯示 `Approved` 且未過期活動。手動開啟 `index.html` 的 `file://` 網址可能無法讀取 JSON；請透過本機或正式網站伺服器提供頁面與 JSON。

## 各縣市官方活動來源與去重

管理者透過本機服務開啟 `admin.html`，用「待審核／已核准／全部」分頁、關鍵字及縣市篩選管理活動。待審核活動可按「核准上架」，已核准活動可按「撤回核准」；狀態會寫入 `data/tourism-events.json`，同時更新主頁資料快照，已開啟的主頁會即時重新載入。

啟動管理服務（Windows 可執行專案根目錄的 `啟動活動管理.ps1`；也可使用 PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\啟動活動管理.ps1
```

終端機會印出實際預覽網址；在網址後加 `/admin.html` 管理活動，主頁使用同一網址根目錄。若 8000 埠已被使用，服務會自動改用下一個可用埠。要讓部署在網路上的網站也能接受審核變更，部署環境必須提供相同的寫入 API；純靜態主機無法直接修改 JSON 檔。

`data/county-event-sources.json` 設定 22 縣市的政府觀光／活動行事曆。`scripts/sync-county-events.mjs` 每次讀取來源頁，優先解析 Schema.org Event JSON-LD，再解析活動連結附近的標題和日期。苗栗縣讀取官方最新消息列表，基隆市讀取基隆市文化觀光局活動訊息列表，並逐篇檢視公告內文擷取日期與地點。新找到的活動一律建立為 `Pending`；與現有活動相符時只合併來源網址，不另建重複卡片，也不改動既有核准狀態。

每筆活動的 `source_refs` 記錄合併後的官方來源；`data/county-source-status.json` 記錄每個來源的抓取結果、候選數和失敗原因。被網站反爬機制阻擋或頁面結構變動時，該來源會在報告標記錯誤，其餘來源仍會繼續處理。沒有活動地點座標的候選資料會以縣市中心點估算 ETA，並用 `location_precision: "county"` 標記。

單次更新指令：

```powershell
node scripts/sync-tourism-events.mjs
node scripts/sync-county-events.mjs
```

`.github/workflows/sync-events.yml` 設定每日台灣時間 03:10 執行並提交更新後的活動資料，也可在 GitHub Actions 手動觸發。要啟用排程，需將專案放在 GitHub 儲存庫且允許 Actions 寫入內容；網站需由該儲存庫部署，才能自動看到更新。縣市來源新活動不會自動核准。

若執行環境無法解析官方下載主機，可在瀏覽器從[政府資料開放平臺的「活動－觀光資訊資料庫」資料集](https://data.gov.tw/dataset/7778)下載「觀光資料標準 V2.1—活動 JSON」壓縮檔，然後在專案根目錄執行：

```powershell
node scripts/sync-tourism-events.mjs --file "C:\path\to\Event-json.zip"
```

## 活動欄位

必要欄位：`id`、`status`、`title`、`city`、`district`、`start_date`、`end_date`、`kid_friendly`、`category`、`summary`、`lat`、`lng`、`source_url`。日期格式為 `YYYY-MM-DD`；`kid_friendly` 使用布林值。前端只顯示已核准且尚未過期的資料。

## 檔案

- `services/eventService.js`：讀取 CSV／JSON/Airtable 格式、Mock fallback、狀態與日期過濾。
- `data/county-event-sources.json`、`scripts/sync-county-events.mjs`：縣市官方來源、擷取與跨來源去重。
- `data/county-source-status.json`：最近一次縣市來源抓取結果。
- `data/taiwan.js`：22 縣市、行政區清單、縣市中心與鄰近縣市關係。
- `utils/etaService.js`：距離與交通方式 ETA 估算、Google Maps 交通模式。
- `index.html`：探索、全台總覽、收藏與蒐集介面。
