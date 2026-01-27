// enterpriseStorage.js
// Multi-user enterprise visit storage + simple registration/login in Firebase Realtime DB.
//
// Schema:
//   reg/{userId} = { name, passkey, createdAt }
//   visits/{userId}/{visitPushId} = visitObject
//
// Notes:
// - Keeps backward compatibility: existing calls without userId
//   will continue to use DEFAULT_USER_ID ("default").
// - userId is derived from name via a safe key function (Firebase RTDB key-safe).

import { db } from "./firebase";
import { ref, push, get, remove, child, set } from "firebase/database";

const DEFAULT_USER_ID = "default";

/**
 * Firebase RTDB keys cannot contain: . # $ [ ]
 * We'll create a stable, human-derived id from the name.
 */
export const makeUserIdFromName = (name) => {
  const raw = String(name || "").trim().toLowerCase();

  const safe = raw
    .replace(/[.#$\[\]]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return safe || `user_${Date.now()}`;
};

const normalizeUserId = (maybeUserId) => {
  const u = String(maybeUserId || "").trim();
  return u || DEFAULT_USER_ID;
};

// -------------------- Registration / Login --------------------

/**
 * Register a user (no restriction: any name+passkey).
 * Stores under: reg/{userId}
 *
 * Returns: { userId, name }
 */
export const registerEnterpriseUser = async (name, passkey) => {
  const displayName = String(name || "").trim();
  const pk = String(passkey || "");

  const userId = makeUserIdFromName(displayName);

  await set(ref(db, `reg/${userId}`), {
    name: displayName,
    passkey: pk,
    createdAt: new Date().toISOString()
  });

  return { userId, name: displayName };
};

/**
 * Login by matching stored reg/{userId}.passkey.
 * Returns: { userId, name } on success, or null on failure.
 */
export const loginEnterpriseUser = async (name, passkey) => {
  const displayName = String(name || "").trim();
  const pk = String(passkey || "");

  const userId = makeUserIdFromName(displayName);
  const snap = await get(child(ref(db), `reg/${userId}`));
  if (!snap.exists()) return null;

  const data = snap.val() || {};
  if (String(data.passkey || "") !== pk) return null;

  return { userId, name: String(data.name || displayName) };
};

/**
 * Optional helper: check whether a user exists (by name).
 */
export const getRegisteredEnterpriseUser = async (name) => {
  const displayName = String(name || "").trim();
  const userId = makeUserIdFromName(displayName);
  const snap = await get(child(ref(db), `reg/${userId}`));
  if (!snap.exists()) return null;
  return { userId, ...(snap.val() || {}) };
};

// -------------------- Visits (multi-user) --------------------

/**
 * Save a visit under visits/{userId}.
 * Backward compatible:
 *   saveEnterpriseVisit(visit) => uses DEFAULT_USER_ID.
 *   saveEnterpriseVisit(userId, visit) => explicit user.
 */
export const saveEnterpriseVisit = async (arg1, arg2) => {
  let userId = DEFAULT_USER_ID;
  let visit = arg1;

  if (typeof arg1 === "string" && arg2 && typeof arg2 === "object") {
    userId = normalizeUserId(arg1);
    visit = arg2;
  }

  const visitWithTime = {
    ...(visit || {}),
    savedAt: new Date().toISOString()
  };

  const newRef = push(ref(db, `visits/${userId}`));
  await set(newRef, visitWithTime);

  return newRef.key;
};

/**
 * Get visits for a user from visits/{userId}.
 * Backward compatible:
 *   getEnterpriseVisits() => DEFAULT_USER_ID
 *   getEnterpriseVisits(userId)
 *
 * Returns: [{ id, ...visit }]
 */
export const getEnterpriseVisits = async (userId = DEFAULT_USER_ID) => {
  const uid = normalizeUserId(userId);

  const snap = await get(child(ref(db), `visits/${uid}`));
  if (!snap.exists()) return [];

  const data = snap.val() || {};
  return Object.entries(data).map(([id, v]) => ({ id, ...(v || {}) }));
};

/**
 * Delete a visit at visits/{userId}/{visitId}.
 * Backward compatible:
 *   deleteEnterpriseVisit(visitId) => DEFAULT_USER_ID
 *   deleteEnterpriseVisit(userId, visitId)
 */
export const deleteEnterpriseVisit = async (arg1, arg2) => {
  let userId = DEFAULT_USER_ID;
  let visitId = arg1;

  if (typeof arg1 === "string" && typeof arg2 === "string") {
    userId = normalizeUserId(arg1);
    visitId = arg2;
  }

  if (!visitId) return;

  await remove(ref(db, `visits/${userId}/${visitId}`));
};

// Convenience alias (some codebases import this name)
export const clearEnterpriseVisit = deleteEnterpriseVisit;
