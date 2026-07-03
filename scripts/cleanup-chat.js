// =============================================================
//  チャット履歴の全削除（毎朝 JST 5:00 に GitHub Actions から実行）
//  存在する全ルームの rooms/{room}/chat を削除する。
//  Firebase サービスアカウント（Admin SDK）で認証するため、
//  database.rules.json のクライアント向け制限（作成のみ・編集/削除不可）は
//  Admin SDK には適用されない＝このスクリプトは削除できる。
// =============================================================
const admin = require("firebase-admin");

function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  if (!serviceAccountJson) throw new Error("FIREBASE_SERVICE_ACCOUNT が設定されていません");
  if (!databaseURL) throw new Error("FIREBASE_DATABASE_URL が設定されていません");

  const serviceAccount = JSON.parse(serviceAccountJson);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });

  return admin
    .database()
    .ref("rooms")
    .once("value")
    .then((roomsSnap) => {
      const rooms = roomsSnap.val() || {};
      const roomIds = Object.keys(rooms);
      console.log(`対象ルーム数: ${roomIds.length}`);

      return Promise.all(
        roomIds.map((roomId) => {
          const chatRef = admin.database().ref(`rooms/${roomId}/chat`);
          return chatRef.once("value").then((snap) => {
            if (!snap.exists()) return;
            return chatRef.remove().then(() => {
              console.log(`削除しました: rooms/${roomId}/chat`);
            });
          });
        })
      );
    });
}

main()
  .then(() => {
    console.log("チャット履歴の削除が完了しました");
    process.exit(0);
  })
  .catch((err) => {
    console.error("チャット履歴の削除に失敗しました:", err);
    process.exit(1);
  });
