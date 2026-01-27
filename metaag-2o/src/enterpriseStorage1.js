// src/enterpriseStorage.js
import { db } from "./firebase";
import { ref, push, get, child, remove } from "firebase/database";

// Save a visit to Firebase Realtime Database
export async function saveEnterpriseVisit(visit) {
  try {
      await push(ref(db, "visits"), visit);
          console.log("✅ Visit saved to Firebase Realtime DB:", visit);
            } catch (error) {
                console.error("❌ Error saving to Firebase:", error);
                  }
                  }

                  // Retrieve all visits from Firebase Realtime Database
                  export async function getEnterpriseVisits() {
                    try {
                        const snapshot = await get(child(ref(db), "visits"));
                            if (snapshot.exists()) {
                                  const data = snapshot.val();
                                        return Object.entries(data).map(([id, value]) => ({ id, ...value }));
                                            } else {
                                                  return [];
                                                      }
                                                        } catch (error) {
                                                            console.error("❌ Error fetching from Firebase:", error);
                                                                return [];
                                                                  }
                                                                  }


                                                                  export const clearEnterpriseVisits = () => {
                                                                    localStorage.removeItem("enterpriseVisits");
                                                                    };

export async function deleteEnterpriseVisit(id) {
  if (!id) return;
  await remove(ref(db, `visits/${id}`));
}