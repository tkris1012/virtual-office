// =============================================================
//  Firebase 設定
//  ※「新規作成した Firebase プロジェクト」の設定に置き換えてください。
//    取得方法は README.md の「Firebase セットアップ」を参照。
// =============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBm9SyrMDAfycpo38ZxgZKHgI5dud7Q6mU",
  authDomain: "virtual-office-ec14d.firebaseapp.com",
  databaseURL: "https://virtual-office-ec14d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "virtual-office-ec14d",
  storageBucket: "virtual-office-ec14d.firebasestorage.app",
  messagingSenderId: "1066104130558",
  appId: "1:1066104130558:web:44c989faaefbd3e2b54eaf",
  measurementId: "G-TK8PVNL3B1",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
