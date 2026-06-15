// =============================================================
//  Firebase 設定
//  ※「新規作成した Firebase プロジェクト」の設定に置き換えてください。
//    取得方法は README.md の「Firebase セットアップ」を参照。
// =============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "ここに貼る",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxx",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
