/**
 * i18n.js — Bilingual (zh-TW ↔ en) UI dictionary + tiny apply-DOM engine.
 *
 * Loaded as the FIRST <script> in index.html so every other module can
 * read window.I18n synchronously (the modules' module-init code calls
 * I18n.t at construction time).
 *
 * Spec: docs/specs/i18n-spec.md.
 *   §1   Public API                  →  window.I18n below
 *   §3   Master dictionary           →  ZH / EN objects below
 *   §4.4 The "主線" special case     →  caller is branch_panel/mini_chart/app
 *   §5   Persistence via /api/config →  setLang() POSTs uiLang
 *
 * Dictionary keys are flat namespaced strings (e.g. 'topbar.replay').
 * Variable interpolation: {name} placeholders, resolved by simple regex.
 * NO ICU MessageFormat — keep dependencies at zero (spec §1.3, §7).
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  //  Master dictionary — Traditional Chinese
  // ──────────────────────────────────────────────────────────────────
  const ZH = {
    // §3.1 topbar.*
    'topbar.appTitle':              '超級圖表',
    'topbar.replay':                '重播',
    'topbar.replayTooltip':         '重播 (R)',
    'topbar.layouts':               '版面',
    'topbar.layoutsTooltip':        '版面',
    'topbar.placeOrder':            '下單',
    'topbar.placeOrderTooltip':     '下單 (B / S)',
    'topbar.tradeHistory':          '交易歷史',
    'topbar.tradeHistoryTooltip':   '交易歷史 (T)',
    'topbar.objectTree':            '物件樹',
    'topbar.objectTreeTooltip':     '物件樹',
    'topbar.forkHere':              '在此分支',
    'topbar.forkHereTooltip':       '在此分支 (Alt+F 選擇 K 棒)',
    'topbar.branches':              '分支',
    'topbar.branchesTooltip':       '分支管理',
    'topbar.openDataFolder':        '開啟資料夾',
    'topbar.openDataFolderTooltip': '在檔案總管中開啟 market_data 資料夾',
    'topbar.reloadData':            '重新載入',
    'topbar.reloadDataTooltip':     '重新載入資料 (新增 / 修改檔案後)',
    'topbar.newTab':                '新分頁',
    'topbar.tabClose':              '關閉',

    // §3.2 tool.*
    'tool.cross':                   '十字線（無工具）',
    'tool.trendline':               '趨勢線',
    'tool.trendlineTooltip':        '趨勢線 (Alt+T)',
    'tool.rectangle':               '矩形',
    'tool.rectangleTooltip':        '矩形 (Alt+R)',
    'tool.path':                    '路徑',
    'tool.pathTooltip':             '路徑 (Alt+P)',
    'tool.measure':                 '日期與價格範圍',
    'tool.measureTooltip':          '日期與價格範圍 (Alt+M / Shift+左鍵)',
    'tool.longPosition':            '多頭部位',
    'tool.longPositionTooltip':     '多頭部位 (Alt+L)',
    'tool.shortPosition':           '空頭部位',
    'tool.shortPositionTooltip':    '空頭部位 (Alt+S)',
    'tool.fiboRetrace':             '斐波那契回撤',
    'tool.fiboRetraceTooltip':      '斐波那契回撤 (Alt+F)',
    'tool.fiboExtension':           '斐波那契趨勢擴展',
    'tool.fiboExtensionTooltip':    '斐波那契趨勢擴展 (Alt+E)',
    'tool.positionSettings':        '部位工具設定',
    'tool.clearAll':                '清除全部',
    'tool.addText':                 '+ 新增文字',
    'tool.addTextEditing':          '新增文字',
    // tool.group.* — collapsible left-toolbar group labels (TV-style popup)
    'tool.group.trend':             '趨勢線工具',
    'tool.group.trendTooltip':      '趨勢線工具',
    'tool.group.fibo':              '斐波那契',
    'tool.group.fiboTooltip':       '斐波那契工具',
    'tool.group.forecast':          '預測與測量',
    'tool.group.forecastTooltip':   '預測與測量工具',

    // panel.fibo.* — Fibonacci per-overlay settings popover
    'panel.fibo.titleRetrace':      '斐波那契回撤',
    'panel.fibo.titleExtension':    '斐波那契趨勢擴展',
    'panel.fibo.tabStyle':          '樣式',
    'panel.fibo.tabCoords':         '坐標',
    'panel.fibo.tabVisible':        '可見性',
    'panel.fibo.trendLine':         '趨勢線',
    'panel.fibo.trendLineColor':    '趨勢線顏色',
    'panel.fibo.hLine':             '水平線',
    'panel.fibo.lineSolid':         '實線',
    'panel.fibo.lineDashed':        '虛線',
    'panel.fibo.extend':            '延伸',
    'panel.fibo.extendNone':        '不要延長',
    'panel.fibo.extendLeft':        '向左',
    'panel.fibo.extendRight':       '向右',
    'panel.fibo.extendBoth':        '雙向',
    'panel.fibo.singleColor':       '使用一個顏色',
    'panel.fibo.singleColorTooltip':'統一顏色',
    'panel.fibo.background':        '背景',
    'panel.fibo.reverse':           '反轉',
    'panel.fibo.coordHint':         '（價格，K棒）',
    'panel.fibo.template':          '範本',
    'panel.fibo.tplApplyDefault':   '套用預設值',
    'panel.fibo.tplSaveAs':         '另存為…',
    'panel.fibo.tplNamePrompt':     '範本名稱：',

    // §3.3 replay.*
    'replay.pickBar':               '選擇K線',
    'replay.pickBarTooltip':        '選擇K線',
    'replay.playPause':             '播放/暫停',
    'replay.playPauseTooltip':      '播放/暫停 (Space)',
    'replay.stepBack':              '上一根',
    'replay.stepBackTooltip':       '上一根 (, 逗號)',
    'replay.stepForward':           '下一根',
    'replay.stepForwardTooltip':    '下一根 (. 句號)',
    'replay.subTfTooltip':          '子K線粒度',
    'replay.jumpToEnd':             '跳到最後',
    'replay.exit':                  '關閉重播',
    'replay.statusPickFirst':       '請按「選擇K線」並點擊圖表設定起點',
    'replay.statusPickClick':       '請點擊圖表設定起點（左鍵確定｜右鍵取消）',
    'replay.statusOutOfTf':         '游標超出新 TF 範圍，請重新「選擇K線」',
    'replay.dlgResumeTitle':        '繼續上次的重播？',
    'replay.dlgResumeBody':         '我們已將您上一次的重播儲存在圖表上。您可以從上次中斷的地方繼續，或開始新的重播。',
    'replay.dlgResumeContinue':     '繼續',
    'replay.dlgResumeRestart':      '重新開始',
    'replay.dlgExitTitle':          '離開目前重播？',
    'replay.dlgExitBody':           '您可以儲存此重播，以便稍後繼續觀看。',
    'replay.dlgSaveSession':        '儲存此重播',
    'replay.dlgExit':               '離開',
    'replay.dlgStay':               '停留',

    // §3.4 panel.sim.* + sim.*
    'panel.sim.title':              '下單',
    'panel.sim.modeOrder':          '下單',
    'panel.sim.modeDom':            'DOM',
    'panel.sim.modeDomTooltip':     '尚未實作',
    'sim.typeMarket':               '市場',
    'sim.typeLimit':                '限價',
    'sim.typeStop':                 '停損',
    'sim.typeStopLimit':            '停損限價',
    'sim.typeMarketShort':          '市價',
    'sim.fieldQty':                 '單位',
    'sim.fieldLimitPrice':          '限價',
    'sim.fieldTriggerPrice':        '觸發價格',
    'sim.fieldTickValue':           'Tick 值',
    'sim.fieldNotional':            '交易額',
    'sim.fieldBid':                 '賣出',
    'sim.fieldAsk':                 '買入',
    'sim.btnBuy':                   '買入',
    'sim.btnSell':                  '賣出',
    'sim.ctaBuy':                   '買入 {qty} {symbol}! {type}',
    'sim.ctaSell':                  '賣出 {qty} {symbol}! {type}',
    'sim.warnReplayMode':           '⚠ 切換到重播模式才會 tick by tick 模擬；目前下單會立即用最新K棒成交。',
    'sim.posSideLong':              '看多',
    'sim.posSideShort':             '看空',
    'sim.posHeader':                '{side} {qty} @ {entry}',
    'sim.unrealizedPnl':            '未實現損益',
    'sim.openedAt':                 '進場時間',
    'sim.closeAtMarket':            '市價平倉',
    'sim.flipReverse':              '平倉反手',
    'sim.flipReverseLong':          '平倉反手 (TODO)',
    'sim.tooltipDragPrice':         '拖曳調整價格',
    'sim.tooltipCancelOrder':       '取消訂單',
    'sim.tooltipCancelDraft':       '取消草稿',
    'sim.tooltipCancelTp':          '取消停利',
    'sim.tooltipCancelSl':          '取消停損',
    'sim.tooltipClosePos':          '關閉部位',
    'sim.tooltipDragTp':            '拖曳到價格以新增停利',
    'sim.tooltipDragSl':            '拖曳到價格以新增停損',
    'sim.tooltipWarnTp':            '目標價格已穿過當前K棒',
    'sim.tooltipWarnSl':            '停損價格已穿過當前K棒',
    'sim.btnDiscard':               '捨棄',
    'sim.btnConfirm':               '確認',
    'sim.errQtyZero':               '單位必須大於 0',
    'sim.errLimitRequired':         '限價必填',
    'sim.errTriggerRequired':       '觸發價必填',

    // §3.5 panel.branch.* + branch.*
    'branch.title':                 '分支列表',
    'branch.kindMain':              '主線',
    'branch.kindExec':              '執行',
    'branch.kindDirection':         '方向',
    'branch.kindSandbox':           '沙盒',
    'branch.kindArchived':          '已歸檔',
    'branch.empty':                 '沒有分支',
    'branch.showArchived':          '顯示已歸檔分支',
    'branch.viewing':               '檢視中',
    'branch.miniChart':             '副圖中',
    'branch.promoteToMain':         '升格主線',
    'branch.promoteTooltip':        '升格為主線',
    'branch.forkPointHeader':       '⋎ {ts} 的分支點',
    'branch.barLabel':              '第 {n} 根',
    'branch.parentLabel':           '父分支',
    'branch.parentMain':            '主線',
    'branch.modalExecTitle':        '執行',
    'branch.modalExecSub':          '同方向\n不同 SL/TP',
    'branch.modalDirectionTitle':   '方向',
    'branch.modalDirectionSub':     '改方向\n或不進場',
    'branch.modalSandboxTitle':     '沙盒',
    'branch.modalSandboxSub':       '純探索\n不計入勝率',
    'branch.noteLabel':             '備註',
    'branch.noteOptional':          '選填',
    'branch.placeholderExec':       '為什麼想試這個分支？',
    'branch.placeholderTimeline':   '為什麼想保留這條時間線？',
    'branch.placeholderEntry':      '為什麼想在這裡下單？',
    'branch.placeholderName':       '輸入分支名稱…',
    'branch.placeholderReason':     '輸入理由…（最少 {n} 個字）',
    'branch.placeholderShortDesc':  '一句話總結，hover 即可看到',
    'branch.placeholderLongDesc':   '完整描述：什麼想法、條件、結果觀察...',
    'branch.ctxRename':             '重新命名',
    'branch.ctxNote':               '編輯備註',
    'branch.ctxMini':               '顯示在副圖',
    'branch.ctxUnmini':             '從副圖移除',
    'branch.ctxPromote':            '升格為主線',
    'branch.ctxDelete':             '刪除分支',
    'branch.toastModalSoon':        '升格歷史 modal 將在 Phase 6 step 3 上線',
    'branch.toastModalUnloaded':    '升格 modal 尚未載入',
    'branch.toastEngineUnloaded':   'BranchEngine 尚未載入',
    'branch.toastPromoteFailed':    '升格失敗（請確認分支狀態與理由長度）',
    'branch.contaminationBadge':    '⚠×{n}',
    'branch.promoteStep':           '步驟 {cur} / 3',
    'branch.roleCurrentMain':       '現行主線',
    'branch.roleOriginalMain':      'Original main (初始)',
    'branch.rolePromotedMain':      'Promoted main #{i}',

    // §3.6 panel.objectTree.*
    'panel.objectTree.title':       '物件樹',
    'panel.objectTree.clearAll':    '清除所有繪圖',
    'panel.objectTree.empty':       '（尚無繪圖或指標）',

    // §3.7 panel.settings.* + panel.drawing.* + panel.position.*
    'panel.settings.title':         '設定',
    'panel.settings.navSymbol':     '商品',
    'panel.settings.navLang':       '語言設置',
    'panel.settings.navShortcuts':  '快捷查看',
    'panel.settings.kbarGroup':     'K 線',
    'panel.settings.body':          '主體',
    'panel.settings.border':        '邊框',
    'panel.settings.wick':          '燭芯',
    'panel.settings.upColor':       '上漲色',
    'panel.settings.downColor':     '下跌色',
    'panel.settings.chartGroup':    '主圖',
    'panel.settings.chartBg':       '背景',
    'panel.settings.chartBgTooltip': '主圖背景色',
    'panel.settings.template':      '範本',
    'panel.settings.applyDefault':  '套用預設值',
    'panel.settings.saveAs':        '另存為…',
    'panel.settings.langGroup':     '介面語言',
    'panel.settings.langLabel':     '語言',
    'panel.settings.langHint':      '切換語言會立即生效。',
    'panel.settings.statusReset':   '已重設為預設值(尚未儲存)',
    'panel.settings.statusSaving':  '儲存中…',
    'panel.settings.statusSaved':   '已儲存',
    'panel.settings.statusSaveFailed': '儲存失敗:{err}',
    'panel.drawing.title':          '繪圖',
    'panel.drawing.tabStyle':       '樣式',
    'panel.drawing.tabText':        '文字',
    'panel.drawing.tabVisible':     '可見性',
    'panel.drawing.color':          '顏色',
    'panel.drawing.background':     '背景',
    'panel.drawing.borderToggle':   '框線',
    'panel.drawing.crosshair':      '十字線',
    'panel.drawing.thickness':      '厚度',
    'panel.drawing.lineStyle':      '線條樣式',
    'panel.drawing.textColor':      '文字顏色',
    'panel.drawing.bold':           '粗體',
    'panel.drawing.italic':         '斜體',
    'panel.drawing.textPlaceholder': '輸入文字…',
    'panel.drawing.textAlign':      '文字對齊',
    'panel.drawing.alignTop':       '頂部',
    'panel.drawing.alignInside':    '內部',
    'panel.drawing.alignBottom':    '底部',
    'panel.drawing.alignAbove':     '上方',
    'panel.drawing.alignBelow':     '下方',
    'panel.drawing.alignMiddleH':   '中間',
    'panel.drawing.alignLeft':      '左',
    'panel.drawing.alignCenter':    '中心',
    'panel.drawing.alignRight':     '右',
    'panel.drawing.show':           '顯示繪圖',
    'panel.drawing.locked':         '鎖定（無法拖移）',
    'panel.drawing.tplExisting':    '已存在的名稱',
    'panel.drawing.tplSaveTitle':   '儲存繪圖模板',
    'panel.drawing.tplNameLabel':   '新模板名稱',
    'panel.drawing.tplEmpty':       '（尚無模板）',
    'panel.drawing.tplEmptySaved':  '（尚無儲存的模板）',
    'panel.drawing.tplDelete':      '刪除',
    'panel.drawing.opacity':        '不透明度',
    'panel.drawing.custom':         '自訂',
    'panel.position.title':         '部位設定',
    'panel.position.tabInput':      '輸入',
    'panel.position.tabStyle':      '樣式',
    'panel.position.tabVisible':    '可見性',
    'panel.position.accountSize':   '帳戶大小',
    'panel.position.accountDefault': '系統預設',
    'panel.position.lotSize':       '手數大小',
    'panel.position.risk':          '風險',
    'panel.position.entryPrice':    '進場價',
    'panel.position.leverage':      '槓桿',
    'panel.position.profitLevel':   '利潤水平',
    'panel.position.stopLevel':     '停損水平',
    'panel.position.price':         '價格',
    'panel.position.qtyPrecision':  'QTY精度',
    'panel.position.precDefault':   '預設',
    'panel.position.precInteger':   '整數',
    'panel.position.precNDecimals': '{n}小數',
    'panel.position.line':          '線條',
    'panel.position.stopColor':     '停損顏色',
    'panel.position.targetColor':   '目標顏色',
    'panel.position.textSize':      '文字大小',
    'panel.position.priceLabel':    '價格標籤',
    'panel.position.namedLong':     '多頭部位',
    'panel.position.namedShort':    '空頭部位',
    'panel.position.toolTitle':     '部位工具設定',
    'panel.position.toolAccount':   '帳戶資金 (USD)',
    'panel.position.toolDefaultRisk': '預設風險 (%)',
    'panel.position.toolRounding':  '數量取整',
    'panel.position.toolRoundFloor': '無條件捨去 (推薦)',
    'panel.position.toolRoundRound': '四捨五入',
    'panel.position.toolSymbol':    '商品代碼',
    'panel.position.toolSymbolAuto': '自動偵測',
    'panel.position.toolReset':     '重設預設值',
    'panel.position.unrealized':    '未平倉損益表',
    'panel.position.realized':      '已平倉損益表',
    'panel.position.target':        '目標',
    'panel.position.stop':          '停損',
    'panel.position.qty':           '數量',
    'panel.position.amount':        '金額',
    'panel.position.rrRatio':       '風險/報酬比',
    'panel.position.notApplicable': '不適用',

    // §3.8 history.*
    'history.title':                '交易歷史',
    'history.clear':                '清除',
    'history.clearTooltip':         '清除本分支所有交易',
    'history.download':             '下載',
    'history.downloadTooltip':      '下載交易紀錄為 xlsx',
    'history.colTradeNum':          '交易 #',
    'history.colDateTime':          '日期和時間',
    'history.colOrderType':         '訂單類型',
    'history.colPrice':             '價格',
    'history.colSize':              '大小',
    'history.colNetPnl':            '淨損益',
    'history.colMfe':               '有利波動',
    'history.colMae':               '不利波動',
    'history.colCumPnl':            '累積損益',
    'history.colBranch':            '分支',
    'history.actionsLabel':         '操作',
    'history.entryLabel':           '進場',
    'history.exitLabel':            '出場',
    'history.holdingPos':           '持倉中',
    'history.closedSuffix':         '（已平倉）',
    'history.openSuffix':           '（持倉中）',
    'history.deleteRowTooltip':     '刪除此交易',
    'history.dlgDeleteTitle':       '刪除此筆交易？',
    'history.dlgDeletePrimary':     '刪除',
    'history.dlgClearTitle':        '清除分支 {name} 全部交易？',
    'history.dlgClearPrimary':      '清除',
    'history.dlgExportTitle':       '下載交易紀錄',
    'history.dlgExportMulti':       '主圖 + 副圖（多工作表）',
    'history.dlgExportMultiDesc':   '主圖、副圖各一個工作表',
    'history.dlgExportPerBranch':   '每個分支一個工作表',
    'history.dlgExportPerBranchDesc': '每個分支一個工作表，主線在第一張',
    'history.toastNoBranches':      '沒有可匯出的分支。',
    'history.toastSheetjsLoading':  'xlsx 函式庫尚未載入完成，請稍候再試。',
    'history.exitReasonReverse':   '平倉反手',
    'history.entryReasonReverse':  '反手進場',
    // CSV column headers — used by sim_history.js xlsx export. Listed here
    // so commit 2's sim_history.js can pull them via I18n.t. Kept as 15
    // separate keys (rather than one comma-joined string) to make
    // re-ordering trivial without a string-split parser.
    'history.csv.tradeNum':         '交易 #',
    'history.csv.side':             '方向',
    'history.csv.entryTime':        '進場時間',
    'history.csv.entryType':        '進場類型',
    'history.csv.entryPrice':       '進場價格',
    'history.csv.exitTime':         '出場時間',
    'history.csv.exitType':         '出場類型',
    'history.csv.exitPrice':        '出場價格',
    'history.csv.qty':              '數量',
    'history.csv.notional':         '交易額',
    'history.csv.netPnlUsd':        '淨損益 (USD)',
    'history.csv.netPnlPct':        '淨損益 (%)',
    'history.csv.runupUsd':         '有利波動 (USD)',
    'history.csv.drawdownUsd':      '不利波動 (USD)',
    'history.csv.cumPnlUsd':        '累積損益 (USD)',
    'history.csv.sheetBranchFallback': '分支',

    // §3.9 dlg.* + common.*
    'dlg.layoutNewTitle':           '建立新版面',
    'dlg.layoutNewBtn':             '建立',
    'dlg.layoutNewDefaultName':     '我的版面',
    'dlg.layoutNamePlaceholder':    '我的版面',
    'dlg.layoutNameLabel':          '版面名稱',
    'dlg.layoutRenameTitle':        '重新命名版面',
    'dlg.layoutRenameBtn':          '儲存',
    'dlg.layoutDeleteConfirm':      '確定刪除「{name}」？此版面的繪圖與重播進度都會一併清除。',
    'dlg.layoutFav':                '收藏',
    'dlg.layoutMore':               '更多',
    'dlg.layoutUnnamed':            '未命名',
    'dlg.layoutMenuRename':         '重新命名',
    'dlg.layoutMenuDelete':         '刪除版面',
    'dlg.symSearchTitle':           '商品搜尋',
    'dlg.symSearchPlaceholder':     '輸入商品代號...',
    'dlg.symSearchEmpty':           '沒有符合的商品',
    'dlg.symSearchEmptyAll':        '（目前沒有可用商品）',
    'dlg.symRescanTooltip':         '重新掃描資料夾',
    'dlg.tfPopupTitle':             '變更週期',
    'dlg.tfMonth':                  '月',
    'dlg.tfHour':                   '小時',
    'dlg.tfDay':                    '日',
    'dlg.tfWeek':                   '週',
    'dlg.tfMinute':                 '分鐘',
    'dlg.tfNotApplicable':          '不適用',
    'dlg.confirmClearAll':          '清除所有畫線？',
    'dlg.confirmClearAllExtra':     '清除所有繪圖？（不影響指標）',
    'dlg.tplNamePrompt':            '範本名稱',
    'common.confirm':               '確認',
    'common.cancel':                '取消',
    'common.save':                  '儲存',
    'common.close':                 '關閉',
    'common.delete':                '刪除',
    'common.copy':                  '複製',
    'common.paste':                 '貼上',
    'common.cut':                   '剪下',
    'common.clone':                 '克隆',
    'common.remove':                '移除',
    'common.show':                  '顯示',
    'common.hide':                  '隱藏',
    'common.lock':                  '鎖定',
    'common.unlock':                '解鎖',
    'common.loading':               '載入中…',
    'common.copied':                '已複製',

    // §3.10 ctx.*
    'ctx.clone':                    '克隆',
    'ctx.copy':                     '複製',
    'ctx.cut':                      '剪下',
    'ctx.paste':                    '貼上',
    'ctx.zorderTop':                '置於頂層',
    'ctx.zorderBottom':             '置於底層',
    'ctx.lock':                     '鎖定',
    'ctx.unlock':                   '解鎖',
    'ctx.show':                     '顯示',
    'ctx.hide':                     '隱藏',
    'ctx.remove':                   '移除',
    'ctx.continuePath':             '繼續連接',
    'ctx.settings':                 '設定…',
    'ctx.objectTree':               '物件樹',
    'ctx.tplMenu':                  '圖表模板',
    'ctx.tplSaveAs':                '另存為…',
    'ctx.tplApplyDefault':          '套用預設值',

    // §3.11 onboarding.*
    'onboarding.title':             '目前沒有可用的行情資料',
    'onboarding.body':              '請把商品資料檔(.txt 或 .csv)放到以下資料夾:',
    'onboarding.copy':              '複製',
    'onboarding.copyTooltip':       '複製路徑',
    'onboarding.fileNameNote':      '檔名 = 商品代號 — 例如 NQ1.txt → NQ1',
    'onboarding.formatSummary':     '需要的欄位格式',
    'onboarding.timezone':          '時區',
    'onboarding.granularity':       '粒度',
    'onboarding.btnOpen':           '📁 開啟資料夾',
    'onboarding.btnReload':         '🔄 重新載入',
    'onboarding.errOpenFailed':     '無法開啟資料夾:{err}',
    'onboarding.statusReloading':   '重新載入中…',
    'onboarding.statusFound':       '找到 {n} 個商品,正在啟動…',
    'onboarding.statusEmpty':       '資料夾還是空的 — 請先放入 .txt 或 .csv 檔',
    'onboarding.statusFailed':      '重新載入失敗:{err}',

    // §3.12 app.*
    'app.scanInProgress':           '重新掃描資料夾…',
    'app.scanLoadedNRemovedM':      '已載入 {n} 個、移除 {m} 個',
    'app.scanLoadedN':              '已載入 {n} 個新商品',
    'app.scanRemovedM':             '移除 {m} 個已不存在的商品',
    'app.scanResultBoth':           '已掃描到資料:{added}\n已移除:{removed}',
    'app.scanResultAdded':          '已掃描到資料:{added}',
    'app.scanResultRemoved':        '已移除:{removed}',
    'app.scanResultNone':           '沒有新商品',
    'app.scanFailed':               '掃描失敗:{err}',
    'app.scanFailedShort':          '掃描失敗',
    'app.scanJoinComma':            '、',
    // app.monthFmt — handled by toLocaleString in app.js (spec §4.5),
    // not via dictionary lookup.

    // Triggered at boot when data_service detects a .txt source file's
    // mtime/size changed since the last cache write — i.e. the user
    // edited the file outside the app and Chart_Viewer silently
    // re-parsed. {symbols} is comma-joined.
    'app.dataChangedOne':           '商品 {symbols} 資料已更新,已自動重新載入',
    'app.dataChangedMany':          '商品 {symbols} 資料已更新,已自動重新載入({n} 個)',

    // Auto-default layout name (server creates it on first launch using
    // whatever uiLang was active at the time). Frontend helper
    // displayLayoutName translates the canonical pair "預設版面" /
    // "Default Layout" at render time so toggling lang post-creation
    // also flips the tab label. User-renamed layouts stay verbatim.
    'app.defaultLayoutName':        '預設版面',

    // chart.* — main candle tooltip OHLCV labels (custom-rendered in
    // app.js initChart, NOT from KLineChart's built-in locale because
    // TradingView's compact OHLC bar uses single-char labels).
    'chart.tooltipOpen':            '開',
    'chart.tooltipHigh':            '高',
    'chart.tooltipLow':             '低',
    'chart.tooltipClose':           '收',
    'chart.tooltipVolume':          '量',

    // panel.symspec.* — Symbol Settings modal (commission/tick/point value)
    'panel.symspec.navTitle':       '商品規格',
    'panel.symspec.title':          '商品規格設定',
    'panel.symspec.listHint':       '點選商品 → 編輯跳動量、每點金額、計價貨幣等。資料夾中尚無預設的商品會落到 NQ 預設值,P&L 將不正確 — 請設定。',
    'panel.symspec.colSymbol':      '商品',
    'panel.symspec.colName':        '名稱',
    'panel.symspec.colTick':        '跳動量',
    'panel.symspec.colPointValue':  '每點金額',
    'panel.symspec.colCurrency':    '貨幣',
    'panel.symspec.statusBuiltin':  '預設',
    'panel.symspec.statusOverride': '已自訂',
    'panel.symspec.statusUnknown':  '⚠ 未設定',
    'panel.symspec.editTitle':      '{symbol} - 編輯商品',
    'panel.symspec.fieldDisplayName': '顯示名稱',
    'panel.symspec.fieldKind':      '類型',
    'panel.symspec.kindFuture':     '期貨',
    'panel.symspec.kindSpot':       '現貨',
    'panel.symspec.fieldTickSize':  '最小跳動量',
    'panel.symspec.fieldPointValue':'每大點金額',
    'panel.symspec.fieldLotSize':   '手數大小',
    'panel.symspec.fieldQtyStep':   '最小手數',
    'panel.symspec.fieldSpread':    '預設買賣價差',
    'panel.symspec.fieldSlippage':  '停損滑價(tick)',
    'panel.symspec.fieldCommission':'單邊手續費',
    'panel.symspec.fieldCurrency':  '計價貨幣',
    'panel.symspec.hintCurrency':   '此貨幣只影響 P&L 顯示格式;pointValue / 手續費的數字本身就以該貨幣為單位',
    'panel.symspec.btnReset':       '還原為預設',
    'panel.symspec.btnSave':        '儲存',
    'panel.symspec.btnBack':        '← 返回列表',
    'panel.symspec.savedToast':     '已儲存 {symbol}',
    'panel.symspec.resetToast':     '已還原 {symbol} 為預設',
    'panel.symspec.saveFailedToast':'儲存失敗',
    'panel.symspec.confirmReset':   '確定將「{symbol}」還原為預設值?自訂的設定將會清除。',
    'panel.symspec.warnHistoryNote':'⚠ 修改後僅影響「之後」的新交易;已關閉的歷史交易 P&L 不會重算。',

    // §3.13 tool.shortcuts.*
    'tool.shortcuts.drawTools':       '繪圖工具',
    'tool.shortcuts.drawOps':         '繪圖操作',
    'tool.shortcuts.drawModifiers':   '繪圖修飾鍵（拖曳時按住）',
    'tool.shortcuts.history':         '編輯歷史',
    'tool.shortcuts.replay':          '重播',
    'tool.shortcuts.timeframe':       '時間框架',
    'tool.shortcuts.symbolSearch':    '商品搜尋',
    'tool.shortcuts.simulation':      '模擬交易',
    'tool.shortcuts.branch':          '分支',
    'tool.shortcuts.escAction':       '完成繪製 / 取消選取',
    'tool.shortcuts.delAction':       '刪除選中物件',
    'tool.shortcuts.copyAction':      '複製選中物件',
    'tool.shortcuts.cutAction':       '剪下選中物件',
    'tool.shortcuts.pasteAction':     '貼上至十字準星',
    'tool.shortcuts.cloneAction':     '克隆選中物件',
    'tool.shortcuts.snapOhlc':        '對齊到 K 棒 OHLC',
    'tool.shortcuts.axisLock':        '軸向鎖定（基於前一點）',
    'tool.shortcuts.undo':            '復原上一個動作',
    'tool.shortcuts.redo':            '重做（取消復原）',
    'tool.shortcuts.replayToggle':    '進入 / 離開重播',
    'tool.shortcuts.replayPause':     '暫停 / 播放',
    'tool.shortcuts.replayStepFwd':   '前進一格 sub-bar',
    'tool.shortcuts.replayStepBack':  '後退一格 sub-bar',
    'tool.shortcuts.tfDigitsHint':    '開啟 TF 輸入彈窗（接著輸入 m/h/d/w 後綴）',
    'tool.shortcuts.symbolHint':      '任一字母開啟商品搜尋彈窗（不含 Shift）',
    'tool.shortcuts.tradeListToggle': '切換交易清單抽屜',
    'tool.shortcuts.forkPickMode':    '進入分支點選擇模式（Mode B）',
    'tool.shortcuts.or':              '或',
  };

  // ──────────────────────────────────────────────────────────────────
  //  Master dictionary — English (TradingView terminology, locked)
  // ──────────────────────────────────────────────────────────────────
  const EN = {
    // §3.1 topbar.*
    'topbar.appTitle':              'Supercharts',
    'topbar.replay':                'Bar Replay',
    'topbar.replayTooltip':         'Bar Replay (R)',
    'topbar.layouts':               'Layouts',
    'topbar.layoutsTooltip':        'Layouts',
    'topbar.placeOrder':            'Trade',
    'topbar.placeOrderTooltip':     'Trade (B / S)',
    'topbar.tradeHistory':          'Trade History',
    'topbar.tradeHistoryTooltip':   'Trade History (T)',
    'topbar.objectTree':            'Object Tree',
    'topbar.objectTreeTooltip':     'Object Tree',
    'topbar.forkHere':              'Fork Here',
    'topbar.forkHereTooltip':       'Fork Here (Alt+F to pick bar)',
    'topbar.branches':              'Branches',
    'topbar.branchesTooltip':       'Manage Branches',
    'topbar.openDataFolder':        'Open Data Folder',
    'topbar.openDataFolderTooltip': 'Open market_data folder in file explorer',
    'topbar.reloadData':            'Reload Data',
    'topbar.reloadDataTooltip':     'Reload data (after adding / editing files)',
    'topbar.newTab':                'New Tab',
    'topbar.tabClose':              'Close',

    // §3.2 tool.*
    'tool.cross':                   'Crosshair (no tool)',
    'tool.trendline':               'Trend Line',
    'tool.trendlineTooltip':        'Trend Line (Alt+T)',
    'tool.rectangle':               'Rectangle',
    'tool.rectangleTooltip':        'Rectangle (Alt+R)',
    'tool.path':                    'Path',
    'tool.pathTooltip':             'Path (Alt+P)',
    'tool.measure':                 'Date and Price Range',
    'tool.measureTooltip':          'Date and Price Range (Alt+M / Shift+Click)',
    'tool.longPosition':            'Long Position',
    'tool.longPositionTooltip':     'Long Position (Alt+L)',
    'tool.shortPosition':           'Short Position',
    'tool.shortPositionTooltip':    'Short Position (Alt+S)',
    'tool.fiboRetrace':             'Fib Retracement',
    'tool.fiboRetraceTooltip':      'Fib Retracement (Alt+F)',
    'tool.fiboExtension':           'Trend-Based Fib Extension',
    'tool.fiboExtensionTooltip':    'Trend-Based Fib Extension (Alt+E)',
    'tool.positionSettings':        'Position Tool Settings',
    'tool.clearAll':                'Clear All',
    'tool.addText':                 '+ Add text',
    'tool.addTextEditing':          'Add text',
    // tool.group.* — collapsible left-toolbar group labels (TV-style popup)
    'tool.group.trend':             'Trend Line Tools',
    'tool.group.trendTooltip':      'Trend Line Tools',
    'tool.group.fibo':              'Fibonacci',
    'tool.group.fiboTooltip':       'Fibonacci Tools',
    'tool.group.forecast':          'Forecasting & Measurement',
    'tool.group.forecastTooltip':   'Forecasting & Measurement Tools',

    // §3.3 replay.*
    'replay.pickBar':               'Select bar',
    'replay.pickBarTooltip':        'Select bar',
    'replay.playPause':             'Play / Pause',
    'replay.playPauseTooltip':      'Play / Pause (Space)',
    'replay.stepBack':              'Step Back',
    'replay.stepBackTooltip':       'Step Back (, comma)',
    'replay.stepForward':           'Step Forward',
    'replay.stepForwardTooltip':    'Step Forward (. period)',
    'replay.subTfTooltip':          'Sub-bar granularity',
    'replay.jumpToEnd':             'Jump to real-time chart',
    'replay.exit':                  'Exit Bar Replay',
    'replay.statusPickFirst':       'Click "Select bar" and pick a starting point on the chart',
    'replay.statusPickClick':       'Click on the chart to set the starting point (left-click confirm, right-click cancel)',
    'replay.statusOutOfTf':         'Cursor out of new timeframe range — please pick a bar again',
    'replay.dlgResumeTitle':        'Resume previous Bar Replay?',
    'replay.dlgResumeBody':         'Your previous Bar Replay session is saved. Resume from where you left off, or start a new session.',
    'replay.dlgResumeContinue':     'Continue',
    'replay.dlgResumeRestart':      'Start new',
    'replay.dlgExitTitle':          'Exit current Bar Replay?',
    'replay.dlgExitBody':           'You can save this session to resume it later.',
    'replay.dlgSaveSession':        'Save this session',
    'replay.dlgExit':               'Exit',
    'replay.dlgStay':               'Stay',

    // §3.4 panel.sim.* + sim.*
    'panel.sim.title':              'Trade',
    'panel.sim.modeOrder':          'Order',
    'panel.sim.modeDom':            'DOM',
    'panel.sim.modeDomTooltip':     'Not yet implemented',
    'sim.typeMarket':               'Market',
    'sim.typeLimit':                'Limit',
    'sim.typeStop':                 'Stop',
    'sim.typeStopLimit':            'Stop-Limit',
    'sim.typeMarketShort':          'Mkt',
    'sim.fieldQty':                 'Quantity',
    'sim.fieldLimitPrice':          'Limit Price',
    'sim.fieldTriggerPrice':        'Trigger Price',
    'sim.fieldTickValue':           'Tick Value',
    'sim.fieldNotional':            'Notional',
    'sim.fieldBid':                 'Bid',
    'sim.fieldAsk':                 'Ask',
    'sim.btnBuy':                   'Buy',
    'sim.btnSell':                  'Sell',
    'sim.ctaBuy':                   'Buy {qty} {symbol}! {type}',
    'sim.ctaSell':                  'Sell {qty} {symbol}! {type}',
    'sim.warnReplayMode':           '⚠ Tick-by-tick simulation only runs in Bar Replay mode; orders placed now fill immediately on the latest bar.',
    'sim.posSideLong':              'Long',
    'sim.posSideShort':             'Short',
    'sim.posHeader':                '{side} {qty} @ {entry}',
    'sim.unrealizedPnl':            'Unrealized P&L',
    'sim.openedAt':                 'Opened At',
    'sim.closeAtMarket':            'Close at Market',
    'sim.flipReverse':              'Reverse',
    'sim.flipReverseLong':          'Reverse (TODO)',
    'sim.tooltipDragPrice':         'Drag to adjust price',
    'sim.tooltipCancelOrder':       'Cancel Order',
    'sim.tooltipCancelDraft':       'Cancel Draft',
    'sim.tooltipCancelTp':          'Cancel Take Profit',
    'sim.tooltipCancelSl':          'Cancel Stop Loss',
    'sim.tooltipClosePos':          'Close Position',
    'sim.tooltipDragTp':            'Drag to price to add Take Profit',
    'sim.tooltipDragSl':            'Drag to price to add Stop Loss',
    'sim.tooltipWarnTp':            'Target price has crossed the current bar',
    'sim.tooltipWarnSl':            'Stop price has crossed the current bar',
    'sim.btnDiscard':               'Discard',
    'sim.btnConfirm':               'Confirm',
    'sim.errQtyZero':               'Quantity must be greater than 0',
    'sim.errLimitRequired':         'Limit price is required',
    'sim.errTriggerRequired':       'Trigger price is required',

    // §3.5 panel.branch.* + branch.*
    'branch.title':                 'Branches',
    'branch.kindMain':              'Main',
    'branch.kindExec':              'Execution',
    'branch.kindDirection':         'Direction',
    'branch.kindSandbox':           'Sandbox',
    'branch.kindArchived':          'Archived',
    'branch.empty':                 'No branches',
    'branch.showArchived':          'Show archived branches',
    'branch.viewing':               'Viewing',
    'branch.miniChart':             'In mini chart',
    'branch.promoteToMain':         'Promote to Main',
    'branch.promoteTooltip':        'Promote this branch to Main',
    'branch.forkPointHeader':       '⋎ Fork at {ts}',
    'branch.barLabel':              'Bar #{n}',
    'branch.parentLabel':           'Parent',
    'branch.parentMain':            'Main',
    'branch.modalExecTitle':        'Execution',
    'branch.modalExecSub':          'Same direction\nDifferent SL/TP',
    'branch.modalDirectionTitle':   'Direction',
    'branch.modalDirectionSub':     'Change side\nor skip entry',
    'branch.modalSandboxTitle':     'Sandbox',
    'branch.modalSandboxSub':       'Exploration only\nWon\'t affect stats',
    'branch.noteLabel':             'Note',
    'branch.noteOptional':          'optional',
    'branch.placeholderExec':       'Why try this branch?',
    'branch.placeholderTimeline':   'Why keep this timeline?',
    'branch.placeholderEntry':      'Why enter a trade here?',
    'branch.placeholderName':       'Branch name…',
    'branch.placeholderReason':     'Reason… (at least {n} chars)',
    'branch.placeholderShortDesc':  'One-sentence summary (shown on hover)',
    'branch.placeholderLongDesc':   'Full description: idea, conditions, observations…',
    'branch.ctxRename':             'Rename',
    'branch.ctxNote':               'Edit Note',
    'branch.ctxMini':               'Show in Mini Chart',
    'branch.ctxUnmini':             'Remove from Mini Chart',
    'branch.ctxPromote':            'Promote to Main',
    'branch.ctxDelete':             'Delete Branch',
    'branch.toastModalSoon':        'Promotion history modal coming in Phase 6 step 3',
    'branch.toastModalUnloaded':    'Promotion modal not yet loaded',
    'branch.toastEngineUnloaded':   'BranchEngine not yet loaded',
    'branch.toastPromoteFailed':    'Promotion failed — check branch state and reason length',
    'branch.contaminationBadge':    '⚠×{n}',
    'branch.promoteStep':           'Step {cur} / 3',
    'branch.roleCurrentMain':       'Current main',
    'branch.roleOriginalMain':      'Original main',
    'branch.rolePromotedMain':      'Promoted main #{i}',

    // §3.6 panel.objectTree.*
    'panel.objectTree.title':       'Object Tree',
    'panel.objectTree.clearAll':    'Remove All Drawings',
    'panel.objectTree.empty':       '(No drawings or indicators)',

    // §3.7 panel.settings.* + panel.drawing.* + panel.position.*
    'panel.settings.title':         'Settings',
    'panel.settings.navSymbol':     'Symbol',
    'panel.settings.navLang':       'Language',
    'panel.settings.navShortcuts':  'Keyboard Shortcuts',
    'panel.settings.kbarGroup':     'Candles',
    'panel.settings.body':          'Body',
    'panel.settings.border':        'Borders',
    'panel.settings.wick':          'Wick',
    'panel.settings.upColor':       'Up color',
    'panel.settings.downColor':     'Down color',
    'panel.settings.chartGroup':    'Chart',
    'panel.settings.chartBg':       'Background',
    'panel.settings.chartBgTooltip': 'Chart background color',
    'panel.settings.template':      'Template',
    'panel.settings.applyDefault':  'Apply Defaults',
    'panel.settings.saveAs':        'Save as…',
    'panel.settings.langGroup':     'Interface Language',
    'panel.settings.langLabel':     'Language',
    'panel.settings.langHint':      'Language switches immediately.',
    'panel.settings.statusReset':   'Reset to defaults (unsaved)',
    'panel.settings.statusSaving':  'Saving…',
    'panel.settings.statusSaved':   'Saved',
    'panel.settings.statusSaveFailed': 'Save failed: {err}',
    'panel.drawing.title':          'Drawing',
    'panel.drawing.tabStyle':       'Style',
    'panel.drawing.tabText':        'Text',
    'panel.drawing.tabVisible':     'Visibility',
    'panel.drawing.color':          'Color',
    'panel.drawing.background':     'Background',
    'panel.drawing.borderToggle':   'Border',
    'panel.drawing.crosshair':      'Crosshair',
    'panel.drawing.thickness':      'Thickness',
    'panel.drawing.lineStyle':      'Line Style',
    'panel.drawing.textColor':      'Text color',
    'panel.drawing.bold':           'Bold',
    'panel.drawing.italic':         'Italic',
    'panel.drawing.textPlaceholder': 'Enter text…',
    'panel.drawing.textAlign':      'Text alignment',
    'panel.drawing.alignTop':       'Top',
    'panel.drawing.alignInside':    'Middle',
    'panel.drawing.alignBottom':    'Bottom',
    'panel.drawing.alignAbove':     'Above',
    'panel.drawing.alignBelow':     'Below',
    'panel.drawing.alignMiddleH':   'Middle',
    'panel.drawing.alignLeft':      'Left',
    'panel.drawing.alignCenter':    'Center',
    'panel.drawing.alignRight':     'Right',
    'panel.drawing.show':           'Show drawing',
    'panel.drawing.locked':         'Lock (prevent dragging)',
    'panel.drawing.tplExisting':    'Existing names',
    'panel.drawing.tplSaveTitle':   'Save Drawing Template',
    'panel.drawing.tplNameLabel':   'Template name',
    'panel.drawing.tplEmpty':       '(No templates)',
    'panel.drawing.tplEmptySaved':  '(No saved templates)',
    'panel.drawing.tplDelete':      'Delete',
    'panel.drawing.opacity':        'Opacity',
    'panel.drawing.custom':         'Custom',
    'panel.position.title':         'Position Settings',
    'panel.position.tabInput':      'Inputs',
    'panel.position.tabStyle':      'Style',
    'panel.position.tabVisible':    'Visibility',
    'panel.position.accountSize':   'Account size',
    'panel.position.accountDefault': 'System default',
    'panel.position.lotSize':       'Lot size',
    'panel.position.risk':          'Risk',
    'panel.position.entryPrice':    'Entry price',
    'panel.position.leverage':      'Leverage',
    'panel.position.profitLevel':   'Profit level',
    'panel.position.stopLevel':     'Stop level',
    'panel.position.price':         'Price',
    'panel.position.qtyPrecision':  'Quantity precision',
    'panel.position.precDefault':   'Default',
    'panel.position.precInteger':   'Integer',
    'panel.position.precNDecimals': '{n} decimals',
    'panel.position.line':          'Line',
    'panel.position.stopColor':     'Stop color',
    'panel.position.targetColor':   'Target color',
    'panel.position.textSize':      'Font size',
    'panel.position.priceLabel':    'Price label',
    'panel.position.namedLong':     'Long Position',
    'panel.position.namedShort':    'Short Position',

    // panel.fibo.* — Fibonacci per-overlay settings popover
    'panel.fibo.titleRetrace':      'Fib Retracement',
    'panel.fibo.titleExtension':    'Trend-Based Fib Extension',
    'panel.fibo.tabStyle':          'Style',
    'panel.fibo.tabCoords':         'Coordinates',
    'panel.fibo.tabVisible':        'Visibility',
    'panel.fibo.trendLine':         'Trend line',
    'panel.fibo.trendLineColor':    'Trend line color',
    'panel.fibo.hLine':             'Horizontal line',
    'panel.fibo.lineSolid':         'Solid',
    'panel.fibo.lineDashed':        'Dashed',
    'panel.fibo.extend':            'Extend',
    'panel.fibo.extendNone':        'No extend',
    'panel.fibo.extendLeft':        'Left',
    'panel.fibo.extendRight':       'Right',
    'panel.fibo.extendBoth':        'Both',
    'panel.fibo.singleColor':       'Single color',
    'panel.fibo.singleColorTooltip':'Override level colors',
    'panel.fibo.background':        'Background',
    'panel.fibo.reverse':           'Reverse',
    'panel.fibo.coordHint':         '(price, bar)',
    'panel.fibo.template':          'Template',
    'panel.fibo.tplApplyDefault':   'Apply defaults',
    'panel.fibo.tplSaveAs':         'Save as…',
    'panel.fibo.tplNamePrompt':     'Template name:',
    'panel.position.toolTitle':     'Position Tool Settings',
    'panel.position.toolAccount':   'Account Balance (USD)',
    'panel.position.toolDefaultRisk': 'Default risk (%)',
    'panel.position.toolRounding':  'Quantity rounding',
    'panel.position.toolRoundFloor': 'Floor (recommended)',
    'panel.position.toolRoundRound': 'Round',
    'panel.position.toolSymbol':    'Symbol',
    'panel.position.toolSymbolAuto': 'Auto-detect',
    'panel.position.toolReset':     'Reset to defaults',
    'panel.position.unrealized':    'Open P&L',
    'panel.position.realized':      'Closed P&L',
    'panel.position.target':        'Target',
    'panel.position.stop':          'Stop',
    'panel.position.qty':           'Qty',
    'panel.position.amount':        'Amount',
    'panel.position.rrRatio':       'Risk/Reward Ratio',
    'panel.position.notApplicable': 'N/A',

    // §3.8 history.*
    'history.title':                'Trade History',
    'history.clear':                'Clear',
    'history.clearTooltip':         'Clear all trades on this branch',
    'history.download':             'Download',
    'history.downloadTooltip':      'Download trades as XLSX',
    'history.colTradeNum':          'Trade #',
    'history.colDateTime':          'Date & Time',
    'history.colOrderType':         'Type',
    'history.colPrice':             'Price',
    'history.colSize':              'Size',
    'history.colNetPnl':            'Net P&L',
    'history.colMfe':               'Run-up',
    'history.colMae':               'Drawdown',
    'history.colCumPnl':            'Cumulative P&L',
    'history.colBranch':            'Branch',
    'history.actionsLabel':         'Actions',
    'history.entryLabel':           'Entry',
    'history.exitLabel':            'Exit',
    'history.holdingPos':           'Open',
    'history.closedSuffix':         '(Closed)',
    'history.openSuffix':           '(Open)',
    'history.deleteRowTooltip':     'Delete this trade',
    'history.dlgDeleteTitle':       'Delete this trade?',
    'history.dlgDeletePrimary':     'Delete',
    'history.dlgClearTitle':        'Clear all trades on branch {name}?',
    'history.dlgClearPrimary':      'Clear',
    'history.dlgExportTitle':       'Download Trade History',
    'history.dlgExportMulti':       'Main + mini (multiple sheets)',
    'history.dlgExportMultiDesc':   'One sheet for main, one for mini',
    'history.dlgExportPerBranch':   'One sheet per branch',
    'history.dlgExportPerBranchDesc': 'One sheet per branch, main first',
    'history.toastNoBranches':      'No branches to export.',
    'history.toastSheetjsLoading':  'XLSX library still loading — please retry.',
    'history.exitReasonReverse':    'Reverse',
    'history.entryReasonReverse':   'Reverse Entry',
    'history.csv.tradeNum':         'Trade #',
    'history.csv.side':             'Side',
    'history.csv.entryTime':        'Entry Time',
    'history.csv.entryType':        'Entry Type',
    'history.csv.entryPrice':       'Entry Price',
    'history.csv.exitTime':         'Exit Time',
    'history.csv.exitType':         'Exit Type',
    'history.csv.exitPrice':        'Exit Price',
    'history.csv.qty':              'Quantity',
    'history.csv.notional':         'Notional',
    'history.csv.netPnlUsd':        'Net P&L (USD)',
    'history.csv.netPnlPct':        'Net P&L (%)',
    'history.csv.runupUsd':         'Run-up (USD)',
    'history.csv.drawdownUsd':      'Drawdown (USD)',
    'history.csv.cumPnlUsd':        'Cumulative P&L (USD)',
    'history.csv.sheetBranchFallback': 'Branch',

    // §3.9 dlg.* + common.*
    'dlg.layoutNewTitle':           'New Layout',
    'dlg.layoutNewBtn':             'Create',
    'dlg.layoutNewDefaultName':     'My layout',
    'dlg.layoutNamePlaceholder':    'My layout',
    'dlg.layoutNameLabel':          'Layout name',
    'dlg.layoutRenameTitle':        'Rename Layout',
    'dlg.layoutRenameBtn':          'Save',
    'dlg.layoutDeleteConfirm':      'Delete "{name}"? All drawings and Bar Replay progress on this layout will be removed.',
    'dlg.layoutFav':                'Favorite',
    'dlg.layoutMore':               'More',
    'dlg.layoutUnnamed':            'Untitled',
    'dlg.layoutMenuRename':         'Rename',
    'dlg.layoutMenuDelete':         'Delete Layout',
    'dlg.symSearchTitle':           'Symbol Search',
    'dlg.symSearchPlaceholder':     'Enter symbol…',
    'dlg.symSearchEmpty':           'No matching symbols',
    'dlg.symSearchEmptyAll':        '(No symbols available)',
    'dlg.symRescanTooltip':         'Rescan folder',
    'dlg.tfPopupTitle':             'Change Interval',
    'dlg.tfMonth':                  'Month',
    'dlg.tfHour':                   'Hour',
    'dlg.tfDay':                    'Day',
    'dlg.tfWeek':                   'Week',
    'dlg.tfMinute':                 'Minute',
    'dlg.tfNotApplicable':          'N/A',
    'dlg.confirmClearAll':          'Remove all drawings?',
    'dlg.confirmClearAllExtra':     'Remove all drawings? (Indicators unaffected)',
    'dlg.tplNamePrompt':            'Template name',
    'common.confirm':               'Confirm',
    'common.cancel':                'Cancel',
    'common.save':                  'Save',
    'common.close':                 'Close',
    'common.delete':                'Delete',
    'common.copy':                  'Copy',
    'common.paste':                 'Paste',
    'common.cut':                   'Cut',
    'common.clone':                 'Clone',
    'common.remove':                'Remove',
    'common.show':                  'Show',
    'common.hide':                  'Hide',
    'common.lock':                  'Lock',
    'common.unlock':                'Unlock',
    'common.loading':               'Loading…',
    'common.copied':                'Copied',

    // §3.10 ctx.*
    'ctx.clone':                    'Clone',
    'ctx.copy':                     'Copy',
    'ctx.cut':                      'Cut',
    'ctx.paste':                    'Paste',
    'ctx.zorderTop':                'Bring to Front',
    'ctx.zorderBottom':             'Send to Back',
    'ctx.lock':                     'Lock',
    'ctx.unlock':                   'Unlock',
    'ctx.show':                     'Show',
    'ctx.hide':                     'Hide',
    'ctx.remove':                   'Remove',
    'ctx.continuePath':             'Continue Path',
    'ctx.settings':                 'Settings…',
    'ctx.objectTree':               'Object Tree',
    'ctx.tplMenu':                  'Chart Templates',
    'ctx.tplSaveAs':                'Save as…',
    'ctx.tplApplyDefault':          'Apply Defaults',

    // §3.11 onboarding.*
    'onboarding.title':             'No market data available',
    'onboarding.body':              'Place market data files (.txt or .csv) in:',
    'onboarding.copy':              'Copy',
    'onboarding.copyTooltip':       'Copy path',
    'onboarding.fileNameNote':      'File name = symbol code (e.g. NQ1.txt → symbol NQ1)',
    'onboarding.formatSummary':     'Required CSV columns',
    'onboarding.timezone':          'Timezone',
    'onboarding.granularity':       'Granularity',
    'onboarding.btnOpen':           '📁 Open folder',
    'onboarding.btnReload':         '🔄 Reload',
    'onboarding.errOpenFailed':     'Unable to open folder: {err}',
    'onboarding.statusReloading':   'Reloading…',
    'onboarding.statusFound':       'Found {n} symbols — starting up…',
    'onboarding.statusEmpty':       'Folder is still empty — add .txt or .csv files first',
    'onboarding.statusFailed':      'Reload failed: {err}',

    // §3.12 app.*
    'app.scanInProgress':           'Rescanning folder…',
    'app.scanLoadedNRemovedM':      'Loaded {n}, removed {m}',
    'app.scanLoadedN':              'Loaded {n} new symbols',
    'app.scanRemovedM':             'Removed {m} missing symbols',
    'app.scanResultBoth':           'Found: {added}\nRemoved: {removed}',
    'app.scanResultAdded':          'Found: {added}',
    'app.scanResultRemoved':        'Removed: {removed}',
    'app.scanResultNone':           'No new symbols',
    'app.scanFailed':               'Scan failed: {err}',
    'app.scanFailedShort':          'Scan failed',
    'app.scanJoinComma':            ', ',

    // Cache invalidation toast (see ZH side for trigger conditions).
    'app.dataChangedOne':           'Data file for {symbols} was updated — reloaded automatically',
    'app.dataChangedMany':          'Data files updated — reloaded automatically ({n} symbols: {symbols})',

    // Auto-default layout name (see ZH side).
    'app.defaultLayoutName':        'Default Layout',

    // chart.* — see ZH side for rationale. TradingView convention:
    // compact OHLC bar uses single-letter labels (O / H / L / C),
    // volume gets 'Vol' (closest TV pattern; never shown in compact
    // bar but our tooltip includes it).
    'chart.tooltipOpen':            'O',
    'chart.tooltipHigh':            'H',
    'chart.tooltipLow':             'L',
    'chart.tooltipClose':           'C',
    'chart.tooltipVolume':          'Vol',

    // panel.symspec.* — Symbol Settings modal (commission/tick/point value)
    'panel.symspec.navTitle':       'Symbol Specs',
    'panel.symspec.title':          'Symbol Specs',
    'panel.symspec.listHint':       'Click a symbol to edit its tick size, point value, currency, etc. Symbols not preset here fall back to NQ defaults — P&L will be wrong; please configure them.',
    'panel.symspec.colSymbol':      'Symbol',
    'panel.symspec.colName':        'Name',
    'panel.symspec.colTick':        'Tick',
    'panel.symspec.colPointValue':  'Point Value',
    'panel.symspec.colCurrency':    'Currency',
    'panel.symspec.statusBuiltin':  'Default',
    'panel.symspec.statusOverride': 'Customised',
    'panel.symspec.statusUnknown':  '⚠ Not set',
    'panel.symspec.editTitle':      '{symbol} - Edit Symbol',
    'panel.symspec.fieldDisplayName': 'Display Name',
    'panel.symspec.fieldKind':      'Type',
    'panel.symspec.kindFuture':     'Future',
    'panel.symspec.kindSpot':       'Spot',
    'panel.symspec.fieldTickSize':  'Tick Size',
    'panel.symspec.fieldPointValue':'Point Value',
    'panel.symspec.fieldLotSize':   'Lot Size',
    'panel.symspec.fieldQtyStep':   'Min Qty',
    'panel.symspec.fieldSpread':    'Default Spread',
    'panel.symspec.fieldSlippage':  'Stop Slippage (ticks)',
    'panel.symspec.fieldCommission':'Commission / side',
    'panel.symspec.fieldCurrency':  'Quote Currency',
    'panel.symspec.hintCurrency':   'Currency affects P&L display only; pointValue / commission numbers are interpreted in this currency',
    'panel.symspec.btnReset':       'Reset to default',
    'panel.symspec.btnSave':        'Save',
    'panel.symspec.btnBack':        '← Back to list',
    'panel.symspec.savedToast':     'Saved {symbol}',
    'panel.symspec.resetToast':     'Reset {symbol} to default',
    'panel.symspec.saveFailedToast':'Save failed',
    'panel.symspec.confirmReset':   'Reset "{symbol}" to default? Your customisations will be discarded.',
    'panel.symspec.warnHistoryNote':'⚠ Changes only affect FUTURE trades. Closed trades keep the P&L computed at close time.',

    // §3.13 tool.shortcuts.*
    'tool.shortcuts.drawTools':       'Drawing tools',
    'tool.shortcuts.drawOps':         'Drawing actions',
    'tool.shortcuts.drawModifiers':   'Drawing modifiers (hold while dragging)',
    'tool.shortcuts.history':         'History',
    'tool.shortcuts.replay':          'Bar Replay',
    'tool.shortcuts.timeframe':       'Timeframe',
    'tool.shortcuts.symbolSearch':    'Symbol search',
    'tool.shortcuts.simulation':      'Simulated trading',
    'tool.shortcuts.branch':          'Branches',
    'tool.shortcuts.escAction':       'Finish drawing / Deselect',
    'tool.shortcuts.delAction':       'Delete selected object',
    'tool.shortcuts.copyAction':      'Copy selected object',
    'tool.shortcuts.cutAction':       'Cut selected object',
    'tool.shortcuts.pasteAction':     'Paste at crosshair',
    'tool.shortcuts.cloneAction':     'Clone selected object',
    'tool.shortcuts.snapOhlc':        'Snap to bar OHLC',
    'tool.shortcuts.axisLock':        'Axis lock (relative to previous point)',
    'tool.shortcuts.undo':            'Undo',
    'tool.shortcuts.redo':            'Redo',
    'tool.shortcuts.replayToggle':    'Enter / exit Bar Replay',
    'tool.shortcuts.replayPause':     'Pause / Play',
    'tool.shortcuts.replayStepFwd':   'Step forward (one sub-bar)',
    'tool.shortcuts.replayStepBack':  'Step back (one sub-bar)',
    'tool.shortcuts.tfDigitsHint':    'Open timeframe popup (then m/h/d/w suffix)',
    'tool.shortcuts.symbolHint':      'Any letter opens symbol search (without Shift)',
    'tool.shortcuts.tradeListToggle': 'Toggle Trade History drawer',
    'tool.shortcuts.forkPickMode':    'Enter fork-pick mode (Mode B)',
    'tool.shortcuts.or':              'or',
  };

  // ──────────────────────────────────────────────────────────────────
  //  Engine
  // ──────────────────────────────────────────────────────────────────
  const TABLES = { zh: ZH, en: EN };
  const STORAGE_KEY = 'chart_viewer.uiLang';   // mirror of /api/config uiLang for instant boot

  // Platform-aware shortcut display: dictionary strings are authored as
  // Windows-style ("Alt+T", "Ctrl+Z") because that was the original
  // dev environment. On macOS we substitute Apple's standard symbols
  // (⌘ Cmd, ⌥ Option, ⇧ Shift) and drop the "+" between modifier and
  // key so labels look native ("⌥T" not "Alt+T"). Modifier-to-modifier
  // joins keep "+" for readability in multi-key combos ("⌘+⇧+Z").
  const _IS_MAC = (typeof navigator !== 'undefined')
                  && /Mac|iPhone|iPad/i.test(navigator.platform);
  const MAC_TOKEN = { Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Meta: '⌘', Del: '⌦' };
  function macifyToken(tok) {
    return _IS_MAC ? (MAC_TOKEN[tok] || tok) : tok;
  }
  function macifyShortcutString(str) {
    if (!_IS_MAC || typeof str !== 'string') return str;
    // \s* tolerates either form: "Alt+T" (i18n dictionary tooltip strings)
    // AND "Alt + T" (the leftbar group popup hint spans hardcoded into
    // index.html). Both collapse to the spaceless Mac convention "⌥T".
    return str
      .replace(/\bCtrl\s*\+\s*/g,  '⌘')
      .replace(/\bAlt\s*\+\s*/g,   '⌥')
      .replace(/\bShift\s*\+\s*/g, '⇧')
      .replace(/\bCmd\s*\+\s*/g,   '⌘');
  }

  // Read the user's last-chosen language from localStorage BEFORE
  // window.I18n is constructed, so the initial value of `lang` reflects
  // their preference. Without this read, lang always defaults to 'zh'
  // until app.js's async /api/config fetch resolves and calls
  // setLang('en') — which means the first applyDOM() pass renders in
  // Chinese and then re-paints to English a moment later (visible
  // flicker; the user reported the language dropdown showing "English"
  // but the page text still in Chinese until they manually toggled).
  // Returns the explicit user choice if set, else null (caller can
  // distinguish "user has never picked" from "user picked zh"). The
  // null signal lets app.js decide whether to honor server config
  // (no localStorage choice → align with server) or assert localStorage
  // (user explicitly chose on this machine → push to server).
  function _loadStoredLang() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'zh' || v === 'en') return v;
    } catch (e) { /* private mode or storage disabled */ }
    return null;
  }
  const _storedLang = _loadStoredLang();
  // Default to English on first launch — matches server.py's
  // DEFAULT_CONFIG['uiLang'] = 'en' so the page boots fully in English
  // without flicker. Returning users with a saved 'zh' choice stay in
  // Chinese (their localStorage value wins).
  const _initialLang = _storedLang || 'en';
  // Set the <html lang> attribute right away so CSS / accessibility
  // tooling that reads it (font-shaping, screen readers) sees the
  // correct value from the very first paint.
  try { document.documentElement.setAttribute('lang', _initialLang === 'zh' ? 'zh-TW' : 'en'); } catch (e) {}

  function lookupRaw(lang, key) {
    const tbl = TABLES[lang];
    if (tbl && key in tbl) return tbl[key];
    // Graceful degradation: en falls back to ZH if a key is missing in EN
    // (which would be a bug — caught by the assertion in dev). zh missing
    // → return the key itself so the dev SEES the gap.
    if (lang === 'en' && key in ZH) return ZH[key];
    return key;
  }

  function interpolate(str, vars) {
    if (!vars || typeof str !== 'string') return str;
    return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  }

  /**
   * Walk root and replace text/attribute content for every element with
   * a `data-i18n*` attribute. Idempotent — safe to call multiple times.
   *
   * Dev assertion: when lang === 'zh', warn if the markup's ORIGINAL
   * fallback text disagrees with ZH dictionary. This catches cases
   * where someone updates the ZH dictionary but forgets to update the
   * inline fallback in index.html (or vice-versa).
   */
  function applyDOM(root) {
    root = root || document;
    const lang = window.I18n.lang;
    // Mirror what t() does — lookupRaw + macifyShortcutString — so DOM-driven
    // tooltips/labels/placeholders get the same Mac-native modifier glyphs
    // as programmatic t() callers. Without this, `data-i18n-title` strings
    // like "Trend Line (Alt+T)" reach the DOM with the literal Windows
    // notation on macOS.
    const localize = (key) => macifyShortcutString(lookupRaw(lang, key));

    // textContent
    const textNodes = root.querySelectorAll('[data-i18n]');
    for (const el of textNodes) {
      const key = el.getAttribute('data-i18n');
      if (!key) continue;
      const translated = localize(key);
      // Only assert against zh fallback markup the FIRST time we see this
      // node (before we overwrite it). Use a one-shot flag attribute.
      if (lang === 'zh' && !el.hasAttribute('data-i18n-checked')) {
        el.setAttribute('data-i18n-checked', '1');
        const fallback = (el.textContent || '').trim();
        const expected = (ZH[key] || '').trim();
        if (fallback && expected && fallback !== expected) {
          console.warn('[i18n] fallback drift', { key, dom: fallback, dict: expected });
        }
      }
      el.textContent = translated;
    }

    // title attr
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      const key = el.getAttribute('data-i18n-title');
      if (!key) continue;
      el.setAttribute('title', localize(key));
    }

    // placeholder attr
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      const key = el.getAttribute('data-i18n-placeholder');
      if (!key) continue;
      el.setAttribute('placeholder', localize(key));
    }

    // aria-label attr
    for (const el of root.querySelectorAll('[data-i18n-aria]')) {
      const key = el.getAttribute('data-i18n-aria');
      if (!key) continue;
      el.setAttribute('aria-label', localize(key));
    }

    // Leftbar group-popup shortcut hints are static text in index.html
    // (".popup-tool-hotkey" spans) — never routed through any i18n key,
    // so macifyShortcutString never touches them by default. On macOS we
    // sweep them here. Idempotent: the regex only matches the Windows
    // notation, so re-runs after language toggle are no-ops.
    if (_IS_MAC) {
      for (const el of root.querySelectorAll('.popup-tool-hotkey')) {
        const original = el.textContent;
        const macified = macifyShortcutString(original);
        if (macified !== original) el.textContent = macified;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────────────────────────
  window.I18n = {
    lang: _initialLang,
    // True if `lang` came from a real user choice cached in localStorage
    // (vs the 'zh' fallback default). Read by app.js's boot to decide
    // whether to honor server config or to assert localStorage's choice.
    hadStoredLang: _storedLang !== null,

    /** Translate a key. `vars` is a flat object for {placeholder} substitution.
     *  Reads `window.I18n.lang` instead of `this.lang` so the common
     *  `const t = window.I18n.t` alias pattern across modules works
     *  without a `.bind()` (otherwise `this` is undefined and we throw). */
    t(key, vars) {
      return macifyShortcutString(interpolate(lookupRaw(window.I18n.lang, key), vars));
    },

    /** Expose the per-token mapper so renderers that build keycap UI
     *  from a structured array (e.g. drawing.js SHORTCUTS_DATA) can map
     *  individual tokens to platform-native symbols. */
    macifyToken,

    /**
     * Switch to language `code` ('zh' | 'en'). Updates DOM, dispatches
     * 'i18n:change' event for dynamic-render modules, persists to
     * /api/config (fire-and-forget). Idempotent — calling with the same
     * code is a no-op besides re-applying DOM (which is safe).
     */
    async setLang(code) {
      if (code !== 'zh' && code !== 'en') return;
      const changed = (this.lang !== code);
      this.lang = code;
      try { document.documentElement.setAttribute('lang', code === 'zh' ? 'zh-TW' : 'en'); } catch (e) {}
      // Cache locally so a future boot sees the choice instantly even
      // before /api/config resolves.
      try { localStorage.setItem(STORAGE_KEY, code); } catch (e) {}
      // Keep ALL language dropdowns in sync — there's the Settings
      // panel one (#cs-lang-select) plus the onboarding overlay one
      // (#ob-lang-select), both sharing the .cs-lang-select class.
      // wireLangSelect() below sets sel.value once at DOMContentLoaded
      // — but if setLang() fires post-DOMContentLoaded (boot-time
      // server alignment, runtime user action elsewhere), any select
      // that wasn't the trigger would otherwise freeze on its initial
      // value. Symptom the user reported earlier: chart UI in English,
      // dropdown still showing "中文" because lang flipped after
      // wireLangSelect ran.
      try {
        for (const sel of document.querySelectorAll('.cs-lang-select')) {
          if (sel.value !== code) sel.value = code;
        }
      } catch (e) {}
      applyDOM();
      if (changed) {
        try {
          document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: code } }));
        } catch (e) { /* ignore */ }
      }
      // Persist to server. Don't await — UI is already updated.
      try {
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uiLang: code }),
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    },

    applyDOM,
  };

  // Wire the <select> change handler once the DOM is ready. If the spec's
  // app.js boot path has already called I18n.setLang() before this fires,
  // the select's value is set to match by then; this listener takes over
  // for runtime user toggles.
  function wireLangSelect() {
    // All language dropdowns on the page (Settings panel + onboarding
    // overlay both use class .cs-lang-select). Initial value sync at
    // DOMContentLoaded; user-toggle on any of them dispatches setLang
    // which then re-syncs every dropdown via the loop in setLang.
    for (const sel of document.querySelectorAll('.cs-lang-select')) {
      sel.value = window.I18n.lang;
      sel.addEventListener('change', (e) => {
        window.I18n.setLang(e.target.value);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Apply once on first paint so any pre-rendered markup picks up
      // the dictionary even if the user hasn't switched yet.
      applyDOM();
      wireLangSelect();
    });
  } else {
    applyDOM();
    wireLangSelect();
  }
})();
