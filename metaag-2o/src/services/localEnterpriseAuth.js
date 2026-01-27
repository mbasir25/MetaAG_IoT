// src/services/localEnterpriseAuth.js
// Lightweight client-side registration/login using localStorage.
// NOTE: This is NOT secure and is only appropriate for controlled environments.

const LS_REGISTRY = "metaag_enterprise_registry_v1";

const readRegistry = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_REGISTRY) || "{}") || {};
  } catch {
    return {};
  }
};

const writeRegistry = (reg) => {
  localStorage.setItem(LS_REGISTRY, JSON.stringify(reg || {}));
};

const normalizeNameKey = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export const registerEnterpriseUserLocal = async (name, passkey) => {
  const displayName = String(name || "").trim();
  const pk = String(passkey || "");
  if (!displayName) throw new Error("Name is required");
  if (!pk) throw new Error("Passkey is required");

  const key = normalizeNameKey(displayName);
  const reg = readRegistry();
  reg[key] = {
    name: displayName,
    passkey: pk,
    createdAt: new Date().toISOString()
  };
  writeRegistry(reg);

  return { userId: key, name: displayName };
};

export const loginEnterpriseUserLocal = async (name, passkey) => {
  const displayName = String(name || "").trim();
  const pk = String(passkey || "");
  const key = normalizeNameKey(displayName);
  const reg = readRegistry();
  const user = reg[key];
  if (!user) return null;
  if (String(user.passkey || "") !== pk) return null;
  return { userId: key, name: user.name || displayName };
};
