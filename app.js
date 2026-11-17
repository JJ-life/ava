/**
 * AI 智慧筆記摘要與重點整理助手
 * 前端核心業務邏輯與 Google Gemini API 串接模組
 */

// DOM 元素快取
const apiKeyInput = document.getElementById('api-key-input');
const toggleKeyBtn = document.getElementById('toggle-key-visibility');
const modelSelect = document.getElementById('model-select');
const contentInput = document.getElementById('content-input');
const charCount = document.getElementById('char-count');
const generateBtn = document.getElementById('generate-btn');
const emptyState = document.getElementById('empty-state');
const loadingState = document.getElementById('loading-state');
const resultMarkdown = document.getElementById('result-markdown');
const copyBtn = document.getElementById('copy-btn');
const copyText = document.getElementById('copy-text');
const exportMdBtn = document.getElementById('export-md-btn');
const clearInputBtn = document.getElementById('clear-input-btn');
const sampleArticleBtn = document.getElementById('sample-article');
const sampleMeetingBtn = document.getElementById('sample-meeting');
const apiStatusBadge = document.getElementById('api-status-badge');
const apiStatusText = document.getElementById('api-status-text');
const toastEl = document.getElementById('toast');
const modeButtons = document.querySelectorAll('#mode-selector .pill');

// 狀態管理
let currentMode = 'summary'; // 'summary' | 'actionable' | 'mindmap' | 'qa' | 'eli5'
let rawMarkdownResult = '';
let isGenerating = false;

// 本地存儲鍵名
const STORAGE_KEY_API = 'gemini_api_key_v1';
const STORAGE_KEY_MODEL = 'gemini_selected_model_v1';

// 初始化
function init() {
  loadStoredPreferences();
  bindEventListeners();
  updateCharCount();
  updateApiStatus();
}

// 載入本地儲存的金鑰與偏好
function loadStoredPreferences() {
  const savedKey = localStorage.getItem(STORAGE_KEY_API);
  if (savedKey) {
    apiKeyInput.value = savedKey;
  }

  const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
  if (savedModel && Array.from(modelSelect.options).some(o => o.value === savedModel)) {
    modelSelect.value = savedModel;
  }
}

// 更新 API 金鑰狀態指示標籤
function updateApiStatus() {
  const hasKey = Boolean(apiKeyInput.value.trim());
  if (hasKey) {
    apiStatusBadge.classList.add('ready');
    apiStatusText.textContent = 'API Key 已就緒';
  } else {
    apiStatusBadge.classList.remove('ready');
    apiStatusText.textContent = '請輸入 API Key';
  }
}

// 字數統計計算
function updateCharCount() {
  const len = contentInput.value.length;
  charCount.textContent = `${len.toLocaleString()} 字元`;
}

// 彈出 Toast 訊息
let toastTimer = null;
function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = 'toast show';
  if (type === 'error') {
    toastEl.classList.add('toast-error');
  } else if (type === 'success') {
    toastEl.classList.add('toast-success');
  }

  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3200);
}

// 模式提示詞構造器
function buildPrompt(text, mode, lengthOption) {
  const lengthGuides = {
    concise: '請保持極度精簡，直切核心，去除任何贅字與非關鍵細節。',
    balanced: '保持重點清晰與脈絡完整平衡，兼顧深度與閱讀效率。',
    detailed: '提供全面深入的剖析，包含細節條列、背景推論與邏輯鏈條。',
  };
  const lengthGuide = lengthGuides[lengthOption] || lengthGuides.balanced;

  let promptInstruction = '';
  switch (mode) {
    case 'summary':
      promptInstruction = `
你是一位頂尖的資深知識架構師與研究員。請針對使用者提供的內容進行結構化「重點摘要與洞見整理」。
格式規範（使用繁體中文 Markdown）：
# 📌 核心速覽 (一句話總結核心精髓)
## 💡 關鍵要點與洞察 (請列出 3~6 點核心要旨，使用粗體標記關鍵概念，並附帶具體說明)
## 🔍 脈絡與細節分析 (按邏輯或主題拆解分項)
## 🌟 總結與延伸思考
要求：${lengthGuide}
`;
      break;

    case 'actionable':
      promptInstruction = `
你是一位敏捷執行力教練與專案管理專家。請將使用者的筆記或文章內容，全數轉化為「具體行動指南與待辦事項」。
格式規範（使用繁體中文 Markdown）：
# 🎯 行動目標綜述
## 📋 關鍵待辦事項清單 (To-Do List，使用 [ ] 核取方塊格式，並標明優先等級 [高/中/低])
## 👥 角色職責或對應對象 (若內容提及)
## ⚠️ 潛在風險與注意事項
## 📅 建議時程與下一階段里程碑 (Next Steps)
要求：${lengthGuide}
`;
      break;

    case 'mindmap':
      promptInstruction = `
你是一位視覺思維與概念拆解專家。請將文章內容重構為「階層式心智圖 (Hierarchical Outline)」。
格式規範（使用繁體中文 Markdown）：
# 🧠 核心概念主軸
使用多層級無序清單（- 階層一 -> - 階層二 -> - 階層三）展開，包含：
- 主題範疇
  - 次分支構念
    - 關鍵事實/論據/數據指標
並在最後附上一個用 Markdown 代碼區塊呈現的精簡 Mermaid 格式心智圖（語法：mindmap ...）。
要求：${lengthGuide}
`;
      break;

    case 'qa':
      promptInstruction = `
你是一位善於蘇格拉底教學法的引導師與考題專家。請將使用者的內容轉化為「QA 核心問答與複習測驗卡片」，幫助讀者檢驗自己是否真正理解內容。
格式規範（使用繁體中文 Markdown）：
# ❓ 關鍵自我檢驗 Q&A (設計 4~6 個高價值深入問題)
針對每個問題提供：
### Q[編號]: [問題敘述]
- **精準解答：** [直接答案]
- **深度解析：** [補充延伸與核心依據]
要求：${lengthGuide}
`;
      break;

    case 'eli5':
      promptInstruction = `
你是一位擅長將艱澀知識用生動生活化比喻說明的科普作家。請用「白話文通俗解說（Explain Like I'm 5）」的風格整理內容。
格式規範（使用繁體中文 Markdown）：
# 💡 一秒搞懂：這篇內容到底在說什麼？
## 🍎 生活化趣味比喻 (用日常身邊事物比擬核心概念)
## 🧩 三大白話核心重點
##  takeaways：這對我們有什麼影響？
要求：語言親切幽默、避免艱深術語（若有術語需搭配直白解釋），${lengthGuide}
`;
      break;

    default:
      promptInstruction = '請以繁體中文為這篇內容進行結構化重點整理與摘要。';
  }

  return `${promptInstruction}\n\n---\n以下是需要整理的原始內容：\n\n${text}`;
}

// 串接 Google Gemini API
async function callGeminiApi(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson.error?.message || response.statusText;
    } catch {
      errorDetail = `HTTP ${response.status}: ${response.statusText}`;
    }
    throw new Error(errorDetail);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];

  if (!candidate || !candidate.content?.parts?.[0]?.text) {
    if (candidate?.finishReason) {
      throw new Error(`產生中斷，原因：${candidate.finishReason}`);
    }
    throw new Error('未能獲取有效模型回傳內容');
  }

  return candidate.content.parts[0].text;
}

// 執行整理主流程
async function handleGenerate() {
  const apiKey = apiKeyInput.value.trim();
  const content = contentInput.value.trim();
  const model = modelSelect.value;
  const lengthOption = document.querySelector('input[name="summary-length"]:checked')?.value || 'balanced';

  if (!apiKey) {
    showToast('請先填寫 Google Gemini API Key！', 'error');
    apiKeyInput.focus();
    return;
  }

  if (!content) {
    showToast('請先輸入或貼上要整理的長文或筆記內容！', 'error');
    contentInput.focus();
    return;
  }

  // 儲存金鑰到 localStorage 便於下次自動帶入
  localStorage.setItem(STORAGE_KEY_API, apiKey);
  localStorage.setItem(STORAGE_KEY_MODEL, model);

  // 切換 UI 載入中狀態
  isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.querySelector('.btn-text').textContent = 'AI 深度整理中...';
  emptyState.style.display = 'none';
  resultMarkdown.style.display = 'none';
  loadingState.style.display = 'flex';

  const prompt = buildPrompt(content, currentMode, lengthOption);

  try {
    const markdownOutput = await callGeminiApi(apiKey, model, prompt);
    rawMarkdownResult = markdownOutput;

    // 使用 marked 渲染 Markdown
    if (window.marked) {
      resultMarkdown.innerHTML = window.marked.parse(markdownOutput);
    } else {
      resultMarkdown.textContent = markdownOutput;
    }

    loadingState.style.display = 'none';
    resultMarkdown.style.display = 'block';
    showToast('重點整理完成！', 'success');
  } catch (error) {
    console.error('Gemini API Error:', error);
    loadingState.style.display = 'none';
    resultMarkdown.style.display = 'block';
    resultMarkdown.innerHTML = `
      <div style="padding: 1.5rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; color: #fca5a5;">
        <h3 style="color: #f87171; margin-bottom: 0.5rem; font-size: 1.1rem;">❌ 呼叫 Gemini API 發生錯誤</h3>
        <p style="font-size: 0.9rem; line-height: 1.6; margin-bottom: 0.75rem;">${error.message}</p>
        <p style="font-size: 0.8rem; color: #cbd5e1;">建議排查方式：<br>1. 請檢查您的 API Key 是否正確無誤且有效。<br>2. 若使用企業/學校帳號，請確認是否具備使用 Gemini API 的權限。<br>3. 請檢查網路連線狀態。</p>
      </div>
    `;
    showToast(`整理失敗：${error.message}`, 'error');
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.querySelector('.btn-text').textContent = '開始智慧整理';
  }
}

// 範例資料庫
const SAMPLES = {
  article: `【AI Agent 技術突破：自主多代理架構在企業自動化的最新落地與挑戰】

隨著大型語言模型（LLM）推理能力的飛躍，人工智慧已從過往的單純聊天問答（Chatbot），邁向具備自主目標規劃、環境感知、外部工具調用與反思修正能力的「AI Agent（自主智慧代理）」。

在傳統企業工作流程中，自動化常受限於固定規則的 RPA（機器人流程自動化），一旦遇到例外情況或非結構化資料便容易崩潰。而新一代 Multi-Agent（多代理）架構，例如以 MetaGPT、CrewAI 與 LangGraph 為代表的框架，透過將複雜專案拆解為「產品經理、架構師、軟體工程師、測試工程師」等多個具備特定角色設定與專門 Prompt 的子代理，實現在軟體開發、法律審約、金融風控等領域的協同合作。

然而，在實際落地中，企業仍面臨三大核心瓶頸：
第一是「幻覺與長路徑累積誤差」。在涉及數十個步驟的長鏈條任務中，若其中某個環節的模型推論偏差 5%，經過五層工具調用與回饋後，整體任務成功率將顯著下滑至 75% 以下。因此，引入「人類在環（Human-in-the-loop）」的關鍵節點審核機制不可或缺。
第二是「資料隱私與企業內部安全權限」。外部雲端 API 雖有最強的推理能力，但企業核心資料可能因此產生合規風險，推動了本地小型開源模型（如 Llama 3 8B / Qwen 2.5 7B）在邊緣代理任務上的盛行。
第三則是「延遲與運算成本」。多代理之間的自我對話與反覆辯論，往往消耗數萬至數十萬 Token，造成反應時間長達數十秒乃至數分鐘。

總結來說，未來的競爭焦點不在於單一基礎模型有多聰明，而在於如何設計高效、穩定且可容錯的代理編排（Orchestration）工作流，讓 AI 真正從「生成內容」走向「完成任務」。`,

  meeting: `專案進度與架構升級會議記錄
會議時間：2026 年 11 月 15 日 14:00 - 15:30
出席人員：Alex (產品主管)、David (技術負責人)、Elena (UI/UX 設計師)、Sarah (資料工程師)

會議重點討論與決議事項：

1. Q4 核心目標與進度檢視：
- 目前使用者對於舊版筆記工具的滿意度調查顯示，超過 72% 使用者認為「文章太長難以抓住重點」，強烈希望加入一鍵提煉精華與行動指針的功能。
- Alex 拍板定案：本季主要衝刺「AI 智慧摘要」模組，預計於 12 月初啟動首批封測。

2. 技術選型與架構規劃：
- David 提出報告：經內部評測，Google Gemini 2.5 系列在繁體中文理解速度與長文本脈絡擷取上表現極為優異，且 Token 成本具備極高性價比。
- 決議前端直接整合 Gemini API，採用輕量化直連模式，並提供使用者自訂模型選擇（如 Flash 與 Pro）。
- Sarah 補充：需嚴格落實無伺服器暫存原則，使用者的筆記資料絕不留存於第三方資料庫，保護資料隱私。

3. 設計與使用者體驗規劃：
- Elena 展示新版視覺規範：採用深色現代科技感（Glassmorphism）配色，強化手機端響應式滑動與卡片式摘要排版。
- 決議在介面上提供多元摘要模式切換（核心重點、待辦指南、心智圖架構、QA 複習）。

4. 團隊分工與待辦清單：
- [高優先] David：於 11 月 22 日前完成前端 API 串接與錯誤處理防護機制。
- [高優先] Elena：於 11 月 20 日前產出行動版與平板端的完整響應式切版樣式。
- [中優先] Alex：負責撰寫使用者指引手冊，並準備 5 組標準測試測試集。
- [中優先] Sarah：評估後續導出 Markdown / PDF 的相容性。

下次追蹤會議：11 月 22 日 14:00。`,
};

// 事件監聽綁定
function bindEventListeners() {
  // 輸入字數更新
  contentInput.addEventListener('input', updateCharCount);

  // API Key 即時更新狀態
  apiKeyInput.addEventListener('input', () => {
    updateApiStatus();
    localStorage.setItem(STORAGE_KEY_API, apiKeyInput.value.trim());
  });

  // 模型選擇變更
  modelSelect.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEY_MODEL, modelSelect.value);
  });

  // 顯隱 API Key
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '👁️';
    }
  });

  // 模式切換按鈕組
  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });

  // 點擊開始整理
  generateBtn.addEventListener('click', handleGenerate);

  // 快速範例填入
  sampleArticleBtn.addEventListener('click', () => {
    contentInput.value = SAMPLES.article;
    updateCharCount();
    showToast('已載入科技文章範例！');
  });

  sampleMeetingBtn.addEventListener('click', () => {
    contentInput.value = SAMPLES.meeting;
    updateCharCount();
    showToast('已載入會議記錄範例！');
  });

  // 清空輸入
  clearInputBtn.addEventListener('click', () => {
    if (contentInput.value && confirm('確定要清空已輸入的內容嗎？')) {
      contentInput.value = '';
      updateCharCount();
      contentInput.focus();
    }
  });

  // 複製結果
  copyBtn.addEventListener('click', async () => {
    if (!rawMarkdownResult) {
      showToast('目前尚無整理內容可複製', 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(rawMarkdownResult);
      copyText.textContent = '已複製！';
      showToast('已成功複製到剪貼簿！', 'success');
      setTimeout(() => {
        copyText.textContent = '複製';
      }, 2000);
    } catch {
      showToast('複製失敗，請手動反白選取', 'error');
    }
  });

  // 匯出 Markdown 檔案
  exportMdBtn.addEventListener('click', () => {
    if (!rawMarkdownResult) {
      showToast('目前尚無整理內容可匯出', 'error');
      return;
    }

    const blob = new Blob([rawMarkdownResult], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `AI筆記摘要_${timestamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('已匯出 Markdown 檔案！', 'success');
  });

  // 快捷鍵支援：Ctrl+Enter 或 Cmd+Enter 快速觸發整理
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (!isGenerating) {
        handleGenerate();
      }
    }
  });
}

// 啟動程式
document.addEventListener('DOMContentLoaded', init);
