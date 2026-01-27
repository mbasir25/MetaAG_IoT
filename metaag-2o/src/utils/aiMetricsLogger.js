// src/utils/aiMetricsLogger.js
import { db } from "../firebase";
import { ref, push } from "firebase/database";

export const logAIMetric = (eventType, payload) => {
  const logRef = ref(db, "eval");
  const entry = {
    eventType,
    timestamp: new Date().toISOString(),
    payload
  };

  push(logRef, entry)
    .then(() => {
      console.log("✅ Logged AI metric:", entry);
    })
    .catch((err) => {
      console.error("❌ Failed to log AI metric:", err);
    });
};
