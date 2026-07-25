rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /patients/{patientId} {
      allow read, write: if request.auth != null;
      match /cards/{cardId} {
        allow read, write: if request.auth != null;
      }
    }
    match /accessCodes/{docId} {
      allow get: if true;                      // 病人查詢用,但一定要拿到正確 docId(hash)才讀得到
      allow list: if request.auth != null;      // 只有登入的治療師能查詢碼是否重複,一般人不能列出
      allow write: if request.auth != null;
    }
  }
}