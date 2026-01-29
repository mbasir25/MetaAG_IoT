import React, { useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, LoadScript, Marker, Polygon } from "@react-google-maps/api";

import polygons from "./data/polygons.json";
import { checkInsidePolygon } from "./geo/geo";
import Chatbot from "./components/Chatbot";
import EnterpriseChatbotRAG from "./components/EnterpriseChatbotRAG";
import FieldMap from "./components/FieldMap";

import { haversineMeters } from "./utils/haversine";
import { registerEnterpriseUserLocal, loginEnterpriseUserLocal } from "./services/localEnterpriseAuth";
import { connectNats, disconnectNats, getNatsEnvConfig, publishJson, subscribeJson } from "./services/natsService";

const containerStyle = { width: "100vw", height: "100vh" };
const defaultCenter = { lat: 40.421, lng: -86.916 };

const LS_USER_ID = "enterprise_userId";
const LS_USER_NAME = "enterprise_userName";

// Visit sessionization knobs
const EXIT_GRACE_MS = 30_000; // must stay outside for 30s to count as a real exit
const MIN_VISIT_SECONDS = 20; // ignore visits shorter than 20s (jitter fragments)

// Matching knobs (phone ↔ machine)
const MACHINE_RECENT_MS = 30_000; // only consider machines that sent a point in the last 30s
const MACHINE_MAX_DISTANCE_M = 500; // optional safety: phone must be within 500m of machine

const GPS_FEED_MAX = 30;

function App() {
  const [mode, setMode] = useState("enterprise"); // "enterprise" | "personal"

  // --- auth ---
  const [userId, setUserId] = useState(() => localStorage.getItem(LS_USER_ID) || "");
  const [userName, setUserName] = useState(() => localStorage.getItem(LS_USER_NAME) || "");
  const isEnterpriseAuthed = mode !== "enterprise" ? true : !!(userId && userName);

  const [authTab, setAuthTab] = useState("login");
  const [authName, setAuthName] = useState("");
  const [authPasskey, setAuthPasskey] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  // --- phone gps UI (device running the browser) ---
  const [position, setPosition] = useState(null);
  const [currentPolygon, setCurrentPolygon] = useState(null);
  const [entryTime, setEntryTime] = useState(null);
  const [exitTime, setExitTime] = useState(null);

  // --- NATS / machine gps ---
  const [natsStatus, setNatsStatus] = useState("disconnected"); // disconnected | connecting | connected | error
  const [natsError, setNatsError] = useState("");
  const [machinesSeen, setMachinesSeen] = useState([]); // unique machine names

  // --- realtime incoming messages feed (machine GPS) ---
  const [gpsFeed, setGpsFeed] = useState([]); // newest first

  // --- pairing ---
  const [pairPrompt, setPairPrompt] = useState(null);
  const [activePair, setActivePair] = useState(null);

  // --- records (built locally, published to NATS on Send) ---
  const [pendingRecords, setPendingRecords] = useState([]); // unsent
  const [lastSendInfo, setLastSendInfo] = useState("");

  // Refs to avoid stale closures inside timers
  const userNameRef = useRef(userName);
  const activePairRef = useRef(activePair);
  const pairPromptRef = useRef(pairPrompt);

  useEffect(() => { userNameRef.current = userName; }, [userName]);
  useEffect(() => { activePairRef.current = activePair; }, [activePair]);
  useEffect(() => { pairPromptRef.current = pairPrompt; }, [pairPrompt]);

  // Phone session ref
  const phoneSessionRef = useRef({
    currentPolygon: null,
    entryTime: null,
    exitTimerId: null,
    lastPoint: null
  });

  // machineSessionsRef.current[vehicle] = { currentPolygon, entryTime, exitTimerId, lastPoint, lastTsMs }
  const machineSessionsRef = useRef({});
  const machineCompletedRef = useRef([]); // { vehicle, field, entryTime, exitTime }

  const nowIso = () => new Date().toISOString();

  const shouldTrackPhone = useMemo(() => {
    if (mode === "personal") return true;
    return isEnterpriseAuthed;
  }, [mode, isEnterpriseAuthed]);

  const shouldUseNatsMachines = useMemo(() => {
    return mode === "enterprise" && isEnterpriseAuthed;
  }, [mode, isEnterpriseAuthed]);

  const clearSessionExitTimer = (session) => {
    if (!session) return;
    if (session.exitTimerId) {
      clearTimeout(session.exitTimerId);
      session.exitTimerId = null;
    }
  };

  const resetAllRuntimeState = () => {
    // Phone
    clearSessionExitTimer(phoneSessionRef.current);
    phoneSessionRef.current = { currentPolygon: null, entryTime: null, exitTimerId: null, lastPoint: null };
    setCurrentPolygon(null);
    setEntryTime(null);
    setExitTime(null);

    // Machines
    Object.values(machineSessionsRef.current || {}).forEach(clearSessionExitTimer);
    machineSessionsRef.current = {};
    machineCompletedRef.current = [];
    setMachinesSeen([]);
    setGpsFeed([]);

    // Pairing
    setPairPrompt(null);
    setActivePair(null);
  };

  const handleLogout = async () => {
    localStorage.removeItem(LS_USER_ID);
    localStorage.removeItem(LS_USER_NAME);
    setUserId("");
    setUserName("");
    setAuthName("");
    setAuthPasskey("");
    setAuthError("");
    setAuthTab("login");

    resetAllRuntimeState();

    try {
      await disconnectNats();
    } finally {
      setNatsStatus("disconnected");
      setNatsError("");
    }
  };

  const handleRegister = async () => {
    setAuthError("");
    setAuthBusy(true);
    try {
      const res = await registerEnterpriseUserLocal(authName, authPasskey);
      localStorage.setItem(LS_USER_ID, res.userId);
      localStorage.setItem(LS_USER_NAME, res.name);
      setUserId(res.userId);
      setUserName(res.name);
      setAuthName("");
      setAuthPasskey("");
    } catch (e) {
      console.error(e);
      setAuthError(e?.message || "Registration failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogin = async () => {
    setAuthError("");
    setAuthBusy(true);
    try {
      const res = await loginEnterpriseUserLocal(authName, authPasskey);
      if (!res) {
        setAuthError("Login failed. Name/passkey not found or incorrect.");
        return;
      }
      localStorage.setItem(LS_USER_ID, res.userId);
      localStorage.setItem(LS_USER_NAME, res.name);
      setUserId(res.userId);
      setUserName(res.name);
      setAuthName("");
      setAuthPasskey("");
    } catch (e) {
      console.error(e);
      setAuthError(e?.message || "Login failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  // --- Pairing logic ---
  const maybeNotify = (title, body) => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    try {
      if (Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      }
    } catch {
      // ignore
    }
  };

  const computePairCandidates = (fieldName, phonePoint) => {
    const sessions = machineSessionsRef.current || {};
    const nowMs = Date.now();
    const candidates = [];

    for (const [vehicle, sess] of Object.entries(sessions)) {
      if (!sess?.currentPolygon || sess.currentPolygon !== fieldName) continue;
      if (!sess.lastTsMs || nowMs - sess.lastTsMs > MACHINE_RECENT_MS) continue;

      const dist = phonePoint && sess.lastPoint ? haversineMeters(phonePoint, sess.lastPoint) : Infinity;
      if (isFinite(dist) && dist > MACHINE_MAX_DISTANCE_M) continue;

      candidates.push({ vehicle, distanceM: dist });
    }

    candidates.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
    return candidates;
  };

  const maybePromptPairing = (fieldName, phonePoint) => {
    if (!fieldName) return;

    const ap = activePairRef.current;
    if (ap && ap.field === fieldName) return;

    if (pairPromptRef.current?.field === fieldName) return;

    const candidates = computePairCandidates(fieldName, phonePoint);
    if (!candidates.length) return;

    const first = candidates[0]?.vehicle;
    setPairPrompt({
      field: fieldName,
      candidates,
      selectedVehicle: first || ""
    });

    if (first) {
      maybeNotify("MetaAg", `Confirm you're with ${first} in ${fieldName}`);
    }
  };

  const confirmPairing = () => {
    if (!pairPrompt?.selectedVehicle || !pairPrompt?.field) {
      setPairPrompt(null);
      return;
    }

    const next = {
      person: userNameRef.current || "",
      vehicle: pairPrompt.selectedVehicle,
      field: pairPrompt.field,
      confirmedAt: nowIso()
    };
    setActivePair(next);
    setPairPrompt(null);
  };

  const clearPairing = () => {
    setActivePair(null);
    setPairPrompt(null);
  };

  // --- Visit sessionization (shared for phone and machine) ---
  const sessionizePoint = ({ session, matchedPolygon, onEnter, onComplete }) => {
    // inside a polygon
    if (matchedPolygon) {
      if (session.currentPolygon && session.exitTimerId) {
        clearSessionExitTimer(session);
      }
      if (matchedPolygon !== session.currentPolygon) {
        clearSessionExitTimer(session);
        session.currentPolygon = matchedPolygon;
        session.entryTime = nowIso();
        onEnter?.(matchedPolygon, session.entryTime);
      }
      return;
    }

    // not inside any polygon
    if (!matchedPolygon && session.currentPolygon) {
      if (!session.exitTimerId) {
        const polygonAtExitStart = session.currentPolygon;
        const entryAt = session.entryTime;

        session.exitTimerId = setTimeout(() => {
          const finalExit = nowIso();
          const durSeconds = entryAt ? (new Date(finalExit) - new Date(entryAt)) / 1000 : 0;

          if (durSeconds >= MIN_VISIT_SECONDS) {
            onComplete?.({
              polygon: polygonAtExitStart,
              entryTime: entryAt,
              exitTime: finalExit
            });
          }

          session.currentPolygon = null;
          session.entryTime = null;
          clearSessionExitTimer(session);
        }, EXIT_GRACE_MS);
      }
    }
  };

  // --- Phone GPS tracking (device running browser) ---
  useEffect(() => {
    if (!shouldTrackPhone) return;
    resetAllRuntimeState();

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setPosition({ lat, lng });

        const phonePoint = { lat, lng };
        const matched = checkInsidePolygon([lng, lat], polygons);

        const session = phoneSessionRef.current;
        const prevPoly = session.currentPolygon;
        session.lastPoint = { lat, lng };

        sessionizePoint({
          session,
          matchedPolygon: matched,
          onEnter: (poly, entryIso) => {
            setCurrentPolygon(poly);
            setEntryTime(entryIso);
            setExitTime(null);
            maybePromptPairing(poly, phonePoint);
          },
          onComplete: (visit) => {
            setExitTime(visit.exitTime);
            setCurrentPolygon(null);

            const ap = activePairRef.current;
            const pairedVehicle = ap && ap.field === visit.polygon ? ap.vehicle : null;

            // Find machine overlap (best-effort)
            let machineVisit = null;
            if (pairedVehicle) {
              const phoneStart = new Date(visit.entryTime).getTime();
              const phoneEnd = new Date(visit.exitTime).getTime();

              const overlaps = machineCompletedRef.current
                .filter((mv) => mv.vehicle === pairedVehicle && mv.field === visit.polygon)
                .filter((mv) => {
                  const ms = new Date(mv.entryTime).getTime();
                  const me = new Date(mv.exitTime).getTime();
                  return ms <= phoneEnd && me >= phoneStart;
                });

              if (overlaps.length) {
                overlaps.sort((a, b) => {
                  const aO =
                    Math.min(phoneEnd, new Date(a.exitTime).getTime()) -
                    Math.max(phoneStart, new Date(a.entryTime).getTime());
                  const bO =
                    Math.min(phoneEnd, new Date(b.exitTime).getTime()) -
                    Math.max(phoneStart, new Date(b.entryTime).getTime());
                  return bO - aO;
                });
                machineVisit = overlaps[0];
              } else {
                const msess = machineSessionsRef.current?.[pairedVehicle];
                if (msess && msess.currentPolygon === visit.polygon && msess.entryTime) {
                  machineVisit = {
                    vehicle: pairedVehicle,
                    field: visit.polygon,
                    entryTime: msess.entryTime,
                    exitTime: null
                  };
                }
              }
            }

            const record = {
              id: `rec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              person: userNameRef.current || "",
              field: visit.polygon,
              vehicle: pairedVehicle,
              phone: {
                entryTime: visit.entryTime,
                exitTime: visit.exitTime
              },
              machine: machineVisit ? { entryTime: machineVisit.entryTime, exitTime: machineVisit.exitTime } : null,
              createdAt: nowIso()
            };

            setPendingRecords((prev) => [record, ...prev]);
          }
        });

        if (matched && matched === prevPoly) {
          maybePromptPairing(matched, phonePoint);
        }
      },
      (err) => console.error("Geolocation error:", err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearSessionExitTimer(phoneSessionRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldTrackPhone]);

  // --- NATS machine subscription (starts after login) ---
  useEffect(() => {
    let unsubscribe = null;

    const run = async () => {
      if (!shouldUseNatsMachines) return;

      const cfg = getNatsEnvConfig();
      setNatsError("");
      setNatsStatus("connecting");

      try {
        await connectNats({ url: cfg.url, name: `metaag-2o-ui:${userId || "anon"}` });
        setNatsStatus("connected");

        unsubscribe = await subscribeJson({
          subject: cfg.gpsSubject, // e.g. "*.gps.>"
          onMessage: (msg) => {
            // Supports your payload example:
            // {"class":"TPV","device":"fake","status":5,"mode":3,"time":"...","lat":...,"lon":...}

            const vehicle = String(
              msg?.device ?? // ✅ your machine id field
              msg?.vehicle ??
              msg?.machine ??
              msg?.vehicleName ??
              msg?.name ??
              ""
            ).trim();

            const lat = Number(msg?.lat ?? msg?.latitude);
            const lng = Number(
              msg?.lng ??
              msg?.lon ?? // ✅ your longitude field
              msg?.long ??
              msg?.longitude
            );

            const tsRaw = msg?.time ?? msg?.ts ?? msg?.timestamp ?? null;
            const tsIso = tsRaw ? new Date(tsRaw).toISOString() : new Date().toISOString();

            if (!vehicle || !isFinite(lat) || !isFinite(lng)) return;

            // update machines seen
            setMachinesSeen((prev) => (prev.includes(vehicle) ? prev : [...prev, vehicle].sort()));

            const matched = checkInsidePolygon([lng, lat], polygons);

            // realtime feed box
            setGpsFeed((prev) => {
              const next = [
                {
                  id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
                  vehicle,
                  ts: tsIso,
                  lat,
                  lng,
                  field: matched || null,
                  raw: msg
                },
                ...prev
              ];
              return next.slice(0, GPS_FEED_MAX);
            });

            // sessionize machine visits
            const sMap = machineSessionsRef.current;
            const session = sMap[vehicle] || {
              currentPolygon: null,
              entryTime: null,
              exitTimerId: null,
              lastPoint: null,
              lastTsMs: null
            };

            session.lastPoint = { lat, lng };
            session.lastTsMs = tsRaw ? new Date(tsRaw).getTime() : Date.now();
            sMap[vehicle] = session;

            sessionizePoint({
              session,
              matchedPolygon: matched,
              onEnter: (poly) => {
                const phonePoly = phoneSessionRef.current?.currentPolygon;
                if (phonePoly && phonePoly === poly && phoneSessionRef.current?.lastPoint) {
                  maybePromptPairing(poly, phoneSessionRef.current.lastPoint);
                }
              },
              onComplete: (visit) => {
                machineCompletedRef.current.push({
                  vehicle,
                  field: visit.polygon,
                  entryTime: visit.entryTime,
                  exitTime: visit.exitTime
                });
              }
            });
          }
        });
      } catch (e) {
        console.error("NATS connect/subscribe error:", e);
        setNatsStatus("error");
        setNatsError(String(e?.message || e)); // show real error
      }
    };

    run();

    return () => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldUseNatsMachines, userId]);

  // Disconnect NATS if enterprise mode or auth goes away
  useEffect(() => {
    if (shouldUseNatsMachines) return;
    (async () => {
      try {
        await disconnectNats();
      } finally {
        setNatsStatus("disconnected");
        setNatsError("");
      }
    })();
  }, [shouldUseNatsMachines]);

  const handleSendRecords = async () => {
    const cfg = getNatsEnvConfig();
    if (!cfg.recordsPublishSubject) {
      alert("Missing REACT_APP_NATS_RECORDS_PUB_SUBJECT");
      return;
    }
    if (!pendingRecords.length) {
      alert("No pending records to send.");
      return;
    }

    try {
      if (natsStatus !== "connected") {
        setNatsStatus("connecting");
        await connectNats({ url: cfg.url, name: `metaag-2o-ui:${userId || "anon"}` });
        setNatsStatus("connected");
      }

      const payload = {
        sentAt: nowIso(),
        source: "metaag-2o-ui",
        person: userNameRef.current || "",
        records: pendingRecords
      };

      await publishJson({ subject: cfg.recordsPublishSubject, data: payload });
      setLastSendInfo(`Sent ${pendingRecords.length} record(s) at ${new Date().toLocaleTimeString()}`);
      setPendingRecords([]);
    } catch (e) {
      console.error(e);
      setNatsStatus("error");
      setNatsError(String(e?.message || e));
      alert(`Failed to send: ${e?.message || e}`);
    }
  };

  // Convert GeoJSON polygon to Google Maps format
  const polygonPaths = polygons.features.map((feature) =>
    feature.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }))
  );

  // Map shortcut
  if (window.location.hash === "#map") return <FieldMap />;

  return (
    <LoadScript googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_API_KEY}>
      <GoogleMap mapContainerStyle={containerStyle} center={position || defaultCenter} zoom={17}>
        {polygonPaths.map((path, i) => (
          <Polygon
            key={i}
            paths={path}
            options={{
              strokeColor: "#007bff",
              fillColor: "#cce5ff",
              strokeWeight: 2,
              fillOpacity: 0.2
            }}
          />
        ))}
        {position && <Marker position={position} />}
      </GoogleMap>

      {/* top-right overlay */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          background: "rgba(255, 255, 255, 0.9)",
          padding: "1rem",
          borderRadius: "8px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          zIndex: 1000,
          maxWidth: "360px",
          width: "360px"
        }}
      >
        <h3 style={{ marginTop: 0 }}>MetaAg 2o</h3>

        <div style={{ marginBottom: "0.75rem" }}>
          <label>
            Mode:{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="personal">Personal</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>
        </div>

        {mode === "enterprise" && (
          <div style={{ marginBottom: "1rem" }}>
            {isEnterpriseAuthed ? (
              <div style={{ fontSize: "14px" }}>
                <div>
                  <strong>User:</strong> {userName}
                </div>

                {/* ✅ show device/browser GPS */}
                <div style={{ marginTop: 6 }}>
                  <strong>My GPS:</strong>{" "}
                  {position ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : "Locating..."}
                </div>

                <div style={{ marginTop: 6 }}>
                  <strong>NATS:</strong> {natsStatus}
                  {natsError ? <div style={{ color: "#b00020" }}>{natsError}</div> : null}
                </div>

                <div style={{ marginTop: 6 }}>
                  <strong>Machines seen:</strong> {machinesSeen.length}
                </div>

                {machinesSeen.length ? (
                  <div style={{ marginTop: 6, maxHeight: 60, overflow: "auto", fontSize: 12 }}>
                    {machinesSeen.join(", ")}
                  </div>
                ) : null}

                {/* ✅ realtime GPS feed */}
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                    Live GPS messages ({gpsFeed.length})
                  </div>

                  <div
                    style={{
                      border: "1px solid #ddd",
                      borderRadius: 8,
                      padding: 8,
                      maxHeight: 180,
                      overflow: "auto",
                      background: "rgba(255,255,255,0.7)",
                      fontSize: 12
                    }}
                  >
                    {gpsFeed.length === 0 ? (
                      <div style={{ color: "#666" }}>Waiting for messages…</div>
                    ) : (
                      gpsFeed.map((m) => (
                        <div key={m.id} style={{ padding: "6px 0", borderBottom: "1px dashed #e5e5e5" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <div>
                              <strong>{m.vehicle}</strong>{" "}
                              <span style={{ color: "#666" }}>{new Date(m.ts).toLocaleTimeString()}</span>
                            </div>
                            <div style={{ fontWeight: 700 }}>
                              {m.field ? (
                                <span style={{ color: "#0a7" }}>IN: {m.field}</span>
                              ) : (
                                <span style={{ color: "#b00" }}>OUTSIDE</span>
                              )}
                            </div>
                          </div>

                          <div style={{ color: "#444", marginTop: 2 }}>
                            {m.lat.toFixed(5)}, {m.lng.toFixed(5)}
                            {m.raw?.status !== undefined ? (
                              <span style={{ color: "#666" }}> • status: {m.raw.status}</span>
                            ) : null}
                            {m.raw?.mode !== undefined ? (
                              <span style={{ color: "#666" }}> • mode: {m.raw.mode}</span>
                            ) : null}
                            {m.raw?.class ? <span style={{ color: "#666" }}> • class: {m.raw.class}</span> : null}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {activePair ? (
                  <div style={{ marginTop: 10, padding: 8, border: "1px solid #ddd", borderRadius: 6 }}>
                    <div>
                      <strong>Paired:</strong> {activePair.vehicle}
                    </div>
                    <div>
                      <strong>Field:</strong> {activePair.field}
                    </div>
                    <button type="button" onClick={clearPairing} style={{ marginTop: 6, width: "100%" }}>
                      Change / Clear pairing
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12, color: "#555" }}>
                    Pairing will be requested when your phone and a machine are in the same field.
                  </div>
                )}

                <button type="button" onClick={handleLogout} style={{ marginTop: "0.75rem", width: "100%" }}>
                  Logout
                </button>
              </div>
            ) : (
              <div style={{ fontSize: "14px" }}>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={() => { setAuthTab("login"); setAuthError(""); }}
                    style={{
                      flex: 1,
                      background: authTab === "login" ? "#007bff" : "#e9ecef",
                      color: authTab === "login" ? "white" : "black",
                      border: "none",
                      padding: "0.5rem",
                      borderRadius: "6px",
                      cursor: "pointer"
                    }}
                  >
                    Login
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAuthTab("register"); setAuthError(""); }}
                    style={{
                      flex: 1,
                      background: authTab === "register" ? "#007bff" : "#e9ecef",
                      color: authTab === "register" ? "white" : "black",
                      border: "none",
                      padding: "0.5rem",
                      borderRadius: "6px",
                      cursor: "pointer"
                    }}
                  >
                    Register
                  </button>
                </div>

                <input
                  type="text"
                  value={authName}
                  onChange={(e) => setAuthName(e.target.value)}
                  placeholder="Name"
                  style={{ width: "100%", padding: "0.5rem", marginBottom: "0.5rem", fontSize: "16px" }}
                />
                <input
                  type="password"
                  value={authPasskey}
                  onChange={(e) => setAuthPasskey(e.target.value)}
                  placeholder="Passkey"
                  style={{ width: "100%", padding: "0.5rem", marginBottom: "0.5rem", fontSize: "16px" }}
                />

                {authError ? <div style={{ color: "#b00020", marginBottom: "0.5rem" }}>{authError}</div> : null}

                {authTab === "login" ? (
                  <button type="button" onClick={handleLogin} disabled={authBusy} style={{ width: "100%", fontSize: "16px" }}>
                    {authBusy ? "Logging in..." : "Login"}
                  </button>
                ) : (
                  <button type="button" onClick={handleRegister} disabled={authBusy} style={{ width: "100%", fontSize: "16px" }}>
                    {authBusy ? "Registering..." : "Register"}
                  </button>
                )}

                <div style={{ marginTop: "0.5rem", color: "#555" }}>
                  {authTab === "register"
                    ? "Registers only on this browser (localStorage)."
                    : "Login to start tracking phone GPS + machine GPS from NATS."}
                </div>
              </div>
            )}
          </div>
        )}

        {currentPolygon ? (
          <div>
            <strong>Inside:</strong> {currentPolygon}
            <br />
            <strong>Entry Time:</strong> {entryTime ? new Date(entryTime).toLocaleTimeString() : ""}
          </div>
        ) : exitTime ? (
          <div>
            <strong>Exited:</strong> {new Date(exitTime).toLocaleTimeString()}
            <br />
            <strong>Location:</strong>
            <br />
            {position ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : "Locating..."}
          </div>
        ) : null}

        {mode === "enterprise" && isEnterpriseAuthed ? (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <strong>Pending records:</strong> {pendingRecords.length}
            </div>
            <button type="button" onClick={handleSendRecords} style={{ width: "100%", fontSize: 16 }}>
              Send records to NATS
            </button>
            {lastSendInfo ? <div style={{ marginTop: 6, fontSize: 12, color: "#555" }}>{lastSendInfo}</div> : null}
            <button
              type="button"
              onClick={() => alert(JSON.stringify(pendingRecords, null, 2))}
              style={{ width: "100%", marginTop: 6 }}
            >
              Preview pending records (JSON)
            </button>
          </div>
        ) : null}
      </div>

      {/* Pairing prompt (in-app confirmation UI) */}
      {pairPrompt ? (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            background: "rgba(255, 255, 255, 0.95)",
            padding: "1rem",
            borderRadius: "10px",
            boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
            zIndex: 1100,
            maxWidth: 420
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Confirm machine</div>
          <div style={{ fontSize: 14, marginBottom: 10 }}>
            Your phone is in <strong>{pairPrompt.field}</strong>. Are you with:
          </div>

          {pairPrompt.candidates.length > 1 ? (
            <select
              value={pairPrompt.selectedVehicle}
              onChange={(e) => setPairPrompt((p) => ({ ...p, selectedVehicle: e.target.value }))}
              style={{ width: "100%", padding: 8, marginBottom: 10 }}
            >
              {pairPrompt.candidates.map((c) => (
                <option key={c.vehicle} value={c.vehicle}>
                  {c.vehicle}
                  {isFinite(c.distanceM) ? ` (≈ ${Math.round(c.distanceM)}m)` : ""}
                </option>
              ))}
            </select>
          ) : (
            <div style={{ marginBottom: 10 }}>
              <strong>{pairPrompt.selectedVehicle}</strong>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={confirmPairing} style={{ flex: 1, fontSize: 16 }}>
              Yes
            </button>
            <button type="button" onClick={() => setPairPrompt(null)} style={{ flex: 1, fontSize: 16 }}>
              No
            </button>
          </div>

          <div style={{ fontSize: 12, color: "#555", marginTop: 8 }}>
            Tip: If you picked the wrong machine, click “Change / Clear pairing” on the right panel.
          </div>
        </div>
      ) : null}

      {/* Chatbots */}
      {mode === "personal" ? <Chatbot apiKey={process.env.REACT_APP_OPENAI_API_KEY} /> : null}

      {mode === "enterprise" && isEnterpriseAuthed ? (
        <EnterpriseChatbotRAG
          userId={userId}
          userName={userName}
          // If your updated EnterpriseChatbotRAG uses this callback, keep it.
          // Otherwise it will be ignored safely.
          onOperationFinalized={(payload) => {
            // You can choose to merge these into pendingRecords if you want
            console.log("Enterprise operation finalized:", payload);
          }}
        />
      ) : null}
    </LoadScript>
  );
}

export default App;
