import { computeAccessDocId } from "./utils.js";
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);

// App Check:確保只有這個網站發出的請求能通過驗證
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6Ler_l0tAAAAAPLIbpO6klwUgk0SPAItyHSyQhQ1"),
  isTokenAutoRefreshEnabled: true,
});

const db = getFirestore(app);

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- 防暴力破解:失敗次數過多時暫時鎖定查詢 ----------
// 注意:這只能擋住「用這個網頁介面」的嘗試,無法阻止有心人直接呼叫 Firebase API,
// 真正的防護仍建議在 Firebase 主控台開啟 App Check。這裡是前端能做到的第一道防線。
const LOCKOUT_KEY = "patientQueryLockout";
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 鎖定 5 分鐘

function getLockoutState() {
  try {
    return JSON.parse(sessionStorage.getItem(LOCKOUT_KEY)) || { count: 0, lockUntil: 0 };
  } catch {
    return { count: 0, lockUntil: 0 };
  }
}
function setLockoutState(state) {
  sessionStorage.setItem(LOCKOUT_KEY, JSON.stringify(state));
}

const queryBtn = document.getElementById("queryBtn");

queryBtn.addEventListener("click", async () => {
  const name = document.getElementById("nameInput").value.trim();
  const code = document.getElementById("codeInput").value.trim();
  const msg = document.getElementById("queryMsg");
  msg.textContent = "";

  // 檢查是否處於鎖定狀態
  const state = getLockoutState();
  if (state.lockUntil > Date.now()) {
    const minsLeft = Math.ceil((state.lockUntil - Date.now()) / 60000);
    msg.textContent = `查詢失敗次數過多,請於 ${minsLeft} 分鐘後再試`;
    return;
  }

  if (!name || !code) {
    msg.textContent = "請輸入姓名與查詢碼";
    return;
  }

  // 防止重複點擊:查詢中停用按鈕並顯示 loading 文字
  queryBtn.disabled = true;
  const originalLabel = queryBtn.textContent;
  queryBtn.textContent = "查詢中…";

  try {
    const docId = await computeAccessDocId(name, code);
    const snap = await getDoc(doc(db, "accessCodes", docId));
    if (!snap.exists()) {
      // 查詢失敗,累計失敗次數,超過上限就鎖定一段時間
      const newCount = state.count + 1;
      if (newCount >= MAX_ATTEMPTS) {
        setLockoutState({ count: 0, lockUntil: Date.now() + LOCKOUT_MS });
        msg.textContent = `查詢失敗次數過多,請於 ${Math.ceil(LOCKOUT_MS / 60000)} 分鐘後再試`;
      } else {
        setLockoutState({ count: newCount, lockUntil: 0 });
        msg.textContent = "查無資料,請確認姓名與查詢碼是否正確";
      }
      return;
    }
    // 查詢成功,重置失敗次數
    setLockoutState({ count: 0, lockUntil: 0 });
    const data = snap.data();
    renderCard(data);
    document.getElementById("loginView").style.display = "none";
    document.getElementById("resultView").style.display = "block";
  } catch (e) {
    msg.textContent = "查詢失敗,請稍後再試";
  } finally {
    // 無論成功或失敗,都要恢復按鈕可點擊狀態
    queryBtn.disabled = false;
    queryBtn.textContent = originalLabel;
  }
});

document.getElementById("backBtn").addEventListener("click", () => {
  document.getElementById("resultView").style.display = "none";
  document.getElementById("loginView").style.display = "block";
  document.getElementById("codeInput").value = "";
});

function renderCard(data) {
  const container = document.getElementById("cardContainer");
  const card = data.latestCard;

  if (!card) {
    container.innerHTML = `
      <div class="med-card">
        <div class="med-card-head">
          <div class="label">衛教卡</div>
          <div class="patient-name">${escapeHtml(data.name)}</div>
        </div>
        <div class="med-item"><div class="advice">治療師尚未建立衛教卡內容,請於下次回診時詢問治療師。</div></div>
      </div>
    `;
    return;
  }

  // 依「新增時間」由新到舊排序,越晚加入的建議顯示在越上面。
  // 沒有 addedAt 的舊資料(此功能上線前建立)一律排到最後面。
  const sortedItems = [...card.items].sort((a, b) => {
    const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0;
    const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0;
    return tb - ta;
  });

  const itemsHtml = sortedItems
    .map((it) => {
      // 沒有 addedAt 的舊資料就退回顯示整張卡片的更新日期。
      const addedDateStr = it.addedAt
        ? new Date(it.addedAt).toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric" })
        : card.date;
      return `
      <div class="med-item">
        <div class="symptom">${escapeHtml(it.symptom)}</div>
        <div class="advice">${escapeHtml(it.advice)}</div>
        <div class="item-date">${escapeHtml(addedDateStr)}</div>
      </div>
    `;
    })
    .join("");

  container.innerHTML = `
    <div class="med-card">
      <div class="med-card-head">
        <div class="label">衛教卡</div>
        <div class="patient-name">${escapeHtml(data.name)}</div>
        <div class="date">更新日期:${escapeHtml(card.date)}</div>
      </div>
      ${itemsHtml}
    </div>
  `;
}