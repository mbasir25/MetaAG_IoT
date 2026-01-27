const STORAGE_KEY = "metaag_logs";

export function saveVisit({ polygon, entryTime, exitTime }) {
  const logs = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];

  logs.push({
    polygon,
    entryTime,
    exitTime,
    synced: false
  });

  localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
}

export function getUnsentVisits() {
  const logs = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  return logs.filter((v) => !v.synced);
}

export function markVisitsAsSynced(entries) {
  const all = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  const updated = all.map((v) =>
    entries.some(
      (e) =>
        e.polygon === v.polygon &&
        e.entryTime === v.entryTime &&
        e.exitTime === v.exitTime
    )
      ? { ...v, synced: true }
      : v
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function removeVisit(visitToRemove) {
  const visits = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  const updated = visits.filter(
    (v) =>
      v.polygon !== visitToRemove.polygon ||
      v.entryTime !== visitToRemove.entryTime ||
      v.exitTime !== visitToRemove.exitTime
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}


