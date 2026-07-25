// utils.js

// 姓名正規化:去除頭尾空白、把全形空白與連續空白都整理成單一半形空白,
// 避免 "王小明" 跟 " 王小明 " 或 "王  小明" 算出不同 hash
export function normalizeName(name) {
  return String(name)
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ");
}

// 手機號碼正規化:只留數字。
// 注意:手機號碼欄位仍保留在病人資料中(供治療師內部聯絡用),
// 但已「不再」參與查詢碼的 hash 計算,查詢改用姓名。
export function normalizePhone(phone) {
  return String(phone).replace(/\D/g, "");
}

// 用瀏覽器內建的 Web Crypto API 算 SHA-256,不需要額外套件。
// 改用「姓名 + 查詢碼」算 hash(原本是「手機號碼 + 查詢碼」),
// 病人端查詢時也要用同一套 name+code 組合才能算出一樣的 docId。
export async function computeAccessDocId(name, code) {
  const input = `${normalizeName(name)}:${code}`;
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}