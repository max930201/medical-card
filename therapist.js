import { computeAccessDocId } from "./utils.js";
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, getDoc, getDocs,
  deleteDoc, query, where, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- 簡單的 HTML escape,避免 Stored XSS ----------
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- 小工具:按鈕在非同步處理期間顯示 loading、防止重複點擊 ----------
async function withLoading(btn, loadingText, task) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingText;
  try {
    return await task();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------- DOM refs ----------
const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const listView = document.getElementById("listView");
const detailView = document.getElementById("detailView");

// ---------- Auth ----------
const loginBtn = document.getElementById("loginBtn");
loginBtn.addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const msg = document.getElementById("loginMsg");
  msg.textContent = "";
  // 用 withLoading 包住登入請求,避免使用者連續點擊「登入」送出多次請求
  await withLoading(loginBtn, "登入中…", async () => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      msg.textContent = "登入失敗,請確認帳號密碼";
    }
  });
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    loginView.style.display = "block";
    appView.style.display = "none";
    return;
  }

  const loginMsg = document.getElementById("loginMsg");

  // 帳密驗證通過(Firebase Auth 登入成功)不代表這個人是治療師,
  // 這裡額外檢查 therapists/{uid} 這份文件存不存在,
  // 不存在就當場登出、顯示提示,不讓畫面進到病人後台。
  try {
    const snap = await getDoc(doc(db, "therapists", user.uid));
    if (!snap.exists()) {
      loginMsg.textContent = "此帳號無治療師權限,請聯繫系統管理員";
      await signOut(auth);
      return;
    }
  } catch (e) {
    loginMsg.textContent = "驗證權限時發生錯誤,請稍後再試";
    await signOut(auth);
    return;
  }

  loginView.style.display = "none";
  appView.style.display = "block";
  showList();
});

// ---------- 病人列表 ----------
async function showList() {
  listView.style.display = "block";
  detailView.style.display = "none";
  document.getElementById("addPatientForm").style.display = "none";

  const listEl = document.getElementById("patientList");
  listEl.innerHTML = `<div class="empty-state">載入中…</div>`;

  let snap;
  try {
    snap = await getDocs(collection(db, "patients"));
  } catch (e) {
    // 最常見的情況:這個帳號已通過 Firebase 登入,但沒有被加進 Firestore 的
    // therapists 名單,所以規則擋下了這次讀取(permission-denied)。
    // 這不是程式錯誤,是安全機制正常運作,但要讓使用者知道發生了什麼事,
    // 而不是讓畫面一直卡在「載入中…」。
    listEl.innerHTML = `<div class="empty-state">
      此帳號沒有治療師權限,無法讀取病人資料。<br>
      請聯繫系統管理員將您的帳號加入治療師名單。
    </div>`;
    return;
  }

  if (snap.empty) {
    listEl.innerHTML = `<div class="empty-state">尚未新增任何病人</div>`;
    return;
  }
  const rows = [];
  snap.forEach((d) => {
    const p = d.data();
    rows.push(`
      <div class="patient-row" data-id="${d.id}">
        <div>
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="phone">${escapeHtml(p.phone || "未填寫手機號碼")}</div>
        </div>
        <div class="tag-code">${escapeHtml(p.accessCode)}</div>
      </div>
    `);
  });
  listEl.innerHTML = rows.join("");
  listEl.querySelectorAll(".patient-row").forEach((row) => {
    row.addEventListener("click", () => openPatient(row.dataset.id));
  });
}

document.getElementById("showAddPatientBtn").addEventListener("click", () => {
  document.getElementById("addPatientForm").style.display = "block";
});
document.getElementById("cancelAddBtn").addEventListener("click", () => {
  document.getElementById("addPatientForm").style.display = "none";
});

// 查詢碼 8 位數字,暴力破解需要嘗試的組合數約 1 億,拉長攻擊者猜中的時間成本。
function generateCode() {
  return String(Math.floor(10000000 + Math.random() * 90000000)); // 8位數字
}

const savePatientBtn = document.getElementById("savePatientBtn");
savePatientBtn.addEventListener("click", async () => {
  const name = document.getElementById("newName").value.trim();
  const phone = document.getElementById("newPhone").value.trim();
  const note = document.getElementById("newNote").value.trim();
  const msg = document.getElementById("addPatientMsg");
  msg.textContent = "";

  // 手機號碼改為選填,只有姓名是必填(因為姓名現在是查詢碼 hash 的一部分)
  if (!name) {
    msg.textContent = "請填寫姓名";
    return;
  }

  await withLoading(savePatientBtn, "建立中…", async () => {
    // 產生不重複的查詢碼(用 query 檢查 accessCode 欄位是否已存在,而不是誤用 doc ID 檢查)
    let code, exists = true, tries = 0;
    while (exists && tries < 10) {
      code = generateCode();
      const q = query(collection(db, "accessCodes"), where("accessCode", "==", code));
      const snap = await getDocs(q);
      exists = !snap.empty;
      tries++;
    }
    if (exists) {
      msg.textContent = "產生查詢碼失敗,請再按一次「建立病人」重試";
      return;
    }

    try {
      const patientRef = await addDoc(collection(db, "patients"), {
        name, phone: phone || "", note: note || "",
        accessCode: code,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      // accessCodes 的文件 ID 改用 computeAccessDocId(name, code) 算出的 hash,
      // 病人端改用「姓名 + 查詢碼」查詢,不再依賴手機號碼。
      const docId = await computeAccessDocId(name, code);
      await setDoc(doc(db, "accessCodes", docId), {
        patientId: patientRef.id,
        name,
        phone: phone || "",
        accessCode: code,
        latestCard: null,
        updatedAt: serverTimestamp(),
      });
      document.getElementById("newName").value = "";
      document.getElementById("newPhone").value = "";
      document.getElementById("newNote").value = "";
      document.getElementById("addPatientForm").style.display = "none";
      showList();
    } catch (e) {
      msg.textContent = "建立失敗,請稍後再試";
    }
  });
});

// ---------- 病人詳細 ----------
let currentPatientId = null;
let currentPatient = null;

async function openPatient(id) {
  currentPatientId = id;
  const snap = await getDoc(doc(db, "patients", id));
  if (!snap.exists()) return;
  currentPatient = snap.data();

  listView.style.display = "none";
  detailView.style.display = "block";

  renderDetailInfo();
  // 每次開啟病人詳細頁,都確保回到「檢視模式」而非停留在編輯表單
  document.getElementById("detailViewMode").style.display = "block";
  document.getElementById("editPatientForm").style.display = "none";

  await loadLatestCardIntoForm(id);
  loadCardHistory(id);
}

function renderDetailInfo() {
  document.getElementById("detailName").textContent = currentPatient.name;
  document.getElementById("detailPhone").textContent = currentPatient.phone || "未填寫手機號碼";
  document.getElementById("detailCode").textContent = currentPatient.accessCode;
}

document.getElementById("backToListBtn").addEventListener("click", showList);

// ---------- 編輯病人姓名/手機號碼 ----------
document.getElementById("editPatientBtn").addEventListener("click", () => {
  document.getElementById("editName").value = currentPatient.name;
  document.getElementById("editPhone").value = currentPatient.phone || "";
  document.getElementById("editPatientMsg").textContent = "";
  document.getElementById("detailViewMode").style.display = "none";
  document.getElementById("editPatientForm").style.display = "block";
});

document.getElementById("cancelEditPatientBtn").addEventListener("click", () => {
  document.getElementById("editPatientForm").style.display = "none";
  document.getElementById("detailViewMode").style.display = "block";
});

const saveEditPatientBtn = document.getElementById("saveEditPatientBtn");
saveEditPatientBtn.addEventListener("click", async () => {
  const newName = document.getElementById("editName").value.trim();
  const newPhone = document.getElementById("editPhone").value.trim();
  const msg = document.getElementById("editPatientMsg");
  msg.textContent = "";

  // 手機號碼改為選填,只有姓名是必填
  if (!newName) {
    msg.textContent = "請填寫姓名";
    return;
  }

  await withLoading(saveEditPatientBtn, "儲存中…", async () => {
    try {
      const oldName = currentPatient.name;
      const code = currentPatient.accessCode;

      // 更新 patients 主文件
      await setDoc(doc(db, "patients", currentPatientId), {
        ...currentPatient,
        name: newName,
        phone: newPhone || "",
        updatedAt: serverTimestamp(),
      });

      // accessCodes 的文件 ID = hash(姓名, 查詢碼),所以「姓名改變」時
      // 舊的 docId 已經對不上,必須刪除舊文件、用新姓名算出新 docId 建立新文件,
      // 否則病人會用新姓名查不到資料,舊姓名卻還能查到(資料不同步的漏洞)。
      const oldDocId = await computeAccessDocId(oldName, code);
      const newDocId = await computeAccessDocId(newName, code);

      // 先讀出舊的 accessCodes 文件,保留 latestCard 內容再搬到新文件
      const oldSnap = await getDoc(doc(db, "accessCodes", oldDocId));
      const latestCard = oldSnap.exists() ? oldSnap.data().latestCard : null;

      if (oldDocId !== newDocId) {
        await deleteDoc(doc(db, "accessCodes", oldDocId));
      }
      await setDoc(doc(db, "accessCodes", newDocId), {
        patientId: currentPatientId,
        name: newName,
        phone: newPhone || "",
        accessCode: code,
        latestCard,
        updatedAt: serverTimestamp(),
      });

      currentPatient = { ...currentPatient, name: newName, phone: newPhone || "" };
      renderDetailInfo();
      document.getElementById("editPatientForm").style.display = "none";
      document.getElementById("detailViewMode").style.display = "block";
      showList(); // 順便讓列表也顯示最新資料;之後點回詳細頁會自動重新載入
    } catch (e) {
      msg.textContent = "儲存失敗,請稍後再試";
    }
  });
});

const deletePatientBtn = document.getElementById("deletePatientBtn");
deletePatientBtn.addEventListener("click", async () => {
  if (!confirm(`確定要刪除病人「${currentPatient.name}」嗎?此動作無法復原。`)) return;

  await withLoading(deletePatientBtn, "刪除中…", async () => {
    const docId = await computeAccessDocId(currentPatient.name, currentPatient.accessCode);
    await deleteDoc(doc(db, "accessCodes", docId));

    // 修正:刪除病人前,先刪除底下所有的歷史衛教卡紀錄(cards 子集合),
    // 避免刪除 patients 主文件後,子集合變成永遠留在資料庫裡的孤兒資料。
    const cardsSnap = await getDocs(collection(db, "patients", currentPatientId, "cards"));
    await Promise.all(cardsSnap.docs.map((cardDoc) => deleteDoc(cardDoc.ref)));

    await deleteDoc(doc(db, "patients", currentPatientId));
    showList();
  });
});

// ---------- 衛教卡項目表單 ----------
const itemsContainer = document.getElementById("itemsContainer");
let itemCount = 0;

function addItemRow(symptom = "", advice = "", addedAt = "") {
  itemCount++;
  const id = `item-${itemCount}-${Date.now()}`;
  const row = document.createElement("div");
  row.className = "item-row";
  row.dataset.rowId = id;
  // addedAt:這筆症狀/建議「第一次被新增」的時間(ISO 字串)。
  // 從舊資料帶入時沿用原本的時間;全新新增的項目則留空,儲存時才補上目前時間,
  // 這樣病人端才能依「新增時間」排序,而不是每次儲存都被洗成同一天。
  row.dataset.addedAt = addedAt;
  row.innerHTML = `
    <div class="item-fields">
      <input type="text" placeholder="症狀,例如:脖子痠" class="symptom-input" value="${escapeHtml(symptom)}">
      <input type="text" placeholder="治療建議,例如:每天早晚拉筋2次,每次30秒" class="advice-input" value="${escapeHtml(advice)}">
    </div>
    <button class="remove-item" title="刪除">✕</button>
  `;
  row.querySelector(".remove-item").addEventListener("click", () => row.remove());
  itemsContainer.appendChild(row);
}

// 開啟病人詳細頁時,把「最近一次」衛教卡的症狀/建議帶入表單,
// 治療師可以直接在既有內容上手動增刪,不用每次重打。
async function loadLatestCardIntoForm(patientId) {
  itemsContainer.innerHTML = "";
  document.getElementById("cardMsg").textContent = "";

  const q = query(
    collection(db, "patients", patientId, "cards"),
    orderBy("createdAt", "desc"),
    limit(1)
  );
  const snap = await getDocs(q);
  const latestItems = snap.empty ? [] : (snap.docs[0].data().items || []);

  if (latestItems.length === 0) {
    addItemRow();
  } else {
    // 舊資料(此功能上線前建立的衛教卡)沒有 it.addedAt,就退回用該次卡片的
    // createdAt 當作新增時間,至少排序時還是合理的。
    const fallbackAddedAt = snap.docs[0].data().createdAt?.toDate?.().toISOString() || "";
    latestItems.forEach((it) => addItemRow(it.symptom, it.advice, it.addedAt || fallbackAddedAt));
  }
}

document.getElementById("addItemBtn").addEventListener("click", () => addItemRow());

const saveCardBtn = document.getElementById("saveCardBtn");
saveCardBtn.addEventListener("click", async () => {
  const rows = itemsContainer.querySelectorAll(".item-row");
  const items = [];
  const nowIso = new Date().toISOString();
  rows.forEach((row) => {
    const symptom = row.querySelector(".symptom-input").value.trim();
    const advice = row.querySelector(".advice-input").value.trim();
    // 沿用舊項目原本的新增時間;新項目(dataset.addedAt 是空字串)則用現在時間。
    const addedAt = row.dataset.addedAt || nowIso;
    if (symptom || advice) items.push({ symptom, advice, addedAt });
  });

  const msg = document.getElementById("cardMsg");
  if (items.length === 0) {
    msg.className = "msg error";
    msg.textContent = "請至少填寫一項症狀與建議";
    return;
  }

  await withLoading(saveCardBtn, "儲存中…", async () => {
    const dateStr = new Date().toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric" });
    const cardData = { date: dateStr, items, createdAt: serverTimestamp() };

    try {
      await addDoc(collection(db, "patients", currentPatientId, "cards"), cardData);
      // 同樣改用 computeAccessDocId(name, code) 算出的 hash 當文件 ID,跟新增病人時保持一致
      const docId = await computeAccessDocId(currentPatient.name, currentPatient.accessCode);
      await setDoc(doc(db, "accessCodes", docId), {
        patientId: currentPatientId,
        name: currentPatient.name,
        phone: currentPatient.phone || "",
        accessCode: currentPatient.accessCode,
        latestCard: { date: dateStr, items },
        updatedAt: serverTimestamp(),
      });
      msg.className = "msg success";
      msg.textContent = "已儲存,病人現在查詢會看到最新內容";
      loadCardHistory(currentPatientId);
    } catch (e) {
      msg.className = "msg error";
      msg.textContent = "儲存失敗,請稍後再試";
    }
  });
});

async function loadCardHistory(patientId) {
  const historyEl = document.getElementById("cardHistory");
  historyEl.innerHTML = `<div class="empty-state">載入中…</div>`;
  const q = query(collection(db, "patients", patientId, "cards"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  if (snap.empty) {
    historyEl.innerHTML = `<div class="empty-state">尚無紀錄</div>`;
    return;
  }
  const blocks = [];
  snap.forEach((d) => {
    const c = d.data();
    const itemsHtml = (c.items || [])
      .map((it) => `<li><strong>${escapeHtml(it.symptom)}</strong>:${escapeHtml(it.advice)}</li>`)
      .join("");
    blocks.push(`
      <div style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--color-border);">
        <div style="color:var(--color-text-muted); font-size:0.85rem; margin-bottom:6px;">${escapeHtml(c.date)}</div>
        <ul style="margin:0; padding-left:20px;">${itemsHtml}</ul>
      </div>
    `);
  });
  historyEl.innerHTML = blocks.join("");
}