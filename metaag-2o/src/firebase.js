// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getDatabase } from "firebase/database";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDEaUum2TK7Xx4_rtRwLillMlEhCHk7DcE",
  authDomain: "metaag2o-7d305.firebaseapp.com",
  databaseURL: "https://metaag2o-7d305-default-rtdb.firebaseio.com",
  projectId: "metaag2o-7d305",
  storageBucket: "metaag2o-7d305.firebasestorage.app",
  messagingSenderId: "337198397211",
  appId: "1:337198397211:web:00096dfbdf16f52cbcc5be",
  measurementId: "G-1NVCYSFBDC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getDatabase(app); // ✅ create this

export { db }; // ✅ now export it