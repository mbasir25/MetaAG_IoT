import React, { useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, LoadScript, Marker, Polygon, Polyline } from "@react-google-maps/api";

import polygons from "./data/polygons.json";
import { checkInsidePolygon } from "./geo/geo";
import Chatbot from "./components/Chatbot";
import EnterpriseChatbotRAG from "./components/EnterpriseChatbotRAG";
import FieldMap from "./components/FieldMap";

import { haversineMeters } from "./utils/haversine";
import { registerEnterpriseUserLocal, loginEnterpriseUserLocal } from "./services/localEnterpriseAuth";
import { connectNats, disconnectNats, getNatsEnvConfig, publishJson, subscribeJson } from "./services/natsService";

const containerStyle = { width: "100%", height: "100%" };
const defaultCenter = { lat: 40.421, lng: -86.916 };

// Map drawing knobs (keep UI responsive)
const MAX_PHONE_POINTS = 500;
const MAX_MACHINE_POINTS_PER_VEHICLE = 300;

const LS_USER_ID = "enterprise_userId";
const LS_USER_NAME = "enterprise_userName";

// Visit sessionization knobs
const EXIT_GRACE_MS = 30_000; // must stay outside for 30s to count as a real exit
const MIN_VISIT_SECONDS = 20; // ignore visits shorter than 20s (jitter fragments)

// Matching knobs (phone ↔ machine)
const MACHINE_RECENT_MS = 30_000; // only consider machines that sent a point in the last 30s
const MACHINE_MAX_DISTANCE_M = 500; // optional safety: phone must be within 500m of machine

const GPS_FEED_MAX = 30;

// ✅ hard requirement from you:
const FORCE_GPS_SUBJECT = "*.gps.TPV";

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

  // --- map drawing state (markers + trails) ---
  const [mapVersion, setMapVersion] = useState(0);
  const phoneTrailRef = useRef([]); // [{lat,lng}]
  const machineTrailRef = useRef({}); // { [vehicle]: [{lat,lng}] }

  const bumpMapVersion = () => setMapVersion((v) => (v + 1) % 1_000_000);

  const pushLimited = (arr, point, maxLen) => {
    arr.push(point);
    if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
  };

  const recordPhonePoint = (pt) => {
    if (!pt) return;
    pushLimited(phoneTrailRef.current, pt, MAX_PHONE_POINTS);
    bumpMapVersion();
  };

  const recordMachinePoint = (vehicle, pt) => {
    if (!vehicle || !pt) return;
    const store = machineTrailRef.current;
    if (!store[vehicle]) store[vehicle] = [];
    pushLimited(store[vehicle], pt, MAX_MACHINE_POINTS_PER_VEHICLE);
    bumpMapVersion();
  };

  const getLatestMachinePoints = () => {
    const out = [];
    const store = machineTrailRef.current;
    for (const [vehicle, pts] of Object.entries(store)) {
      const last = pts?.[pts.length - 1];
      if (last) out.push({ vehicle, point: last });
    }
    return out;
  };

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
  const [chatbotResetKey, setChatbotResetKey] = useState(0);

  // ✅ DEBUG/DIAGNOSTICS (proves subscription + message receipt)
  const [natsSubStatus, setNatsSubStatus] = useState("not_started"); // not_started|subscribing|subscribed|failed|unsubscribed
  const [natsMsgCount, setNatsMsgCount] = useState(0);
  const [natsLastSubject, setNatsLastSubject] = useState("");
  const [natsLastMsgAt, setNatsLastMsgAt] = useState("");
  const [natsLastMsgPreview, setNatsLastMsgPreview] = useState("");
  const [natsUsingSubject, setNatsUsingSubject] = useState(FORCE_GPS_SUBJECT);

  // Refs to avoid stale closures inside timers
  const userNameRef = useRef(userName);
  const activePairRef = useRef(activePair);
  const pairPromptRef = useRef(pairPrompt);

  useEffect(() => {
    userNameRef.current = userName;
  }, [userName]);
  useEffect(() => {
    activePairRef.current = activePair;
  }, [activePair]);
  useEffect(() => {
    pairPromptRef.current = pairPrompt;
  }, [pairPrompt]);

  // Phone session ref
  const phoneSessionRef = useRef({
    currentPolygon: null,
    entryTime: null,
    exitTimerId: null,
    lastPoint: null,
    powerUnit: null // selected machine that overlaps this visit's polygon
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
    phoneSessionRef.current = { currentPolygon: null, entryTime: null, exitTimerId: null, lastPoint: null, powerUnit: null };
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

    // Debug
    setNatsMsgCount(0);
    setNatsLastSubject("");
    setNatsLastMsgAt("");
    setNatsLastMsgPreview("");
    setNatsSubStatus("not_started");
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
      setNatsSubStatus("unsubscribed");
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

  const computePairCandidatesNearPhone = (phonePoint) => {
    if (!phonePoint) return [];
    const sessions = machineSessionsRef.current || {};
    const nowMs = Date.now();
    const candidates = [];

    for (const [vehicle, sess] of Object.entries(sessions)) {
      if (!sess?.lastTsMs || nowMs - sess.lastTsMs > MACHINE_RECENT_MS) continue;
      if (!sess?.lastPoint) continue;

      const dist = haversineMeters(phonePoint, sess.lastPoint);
      if (isFinite(dist) && dist > MACHINE_MAX_DISTANCE_M) continue;

      candidates.push({
        vehicle,
        distanceM: dist,
        field: sess.currentPolygon || null
      });
    }

    candidates.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
    return candidates;
  };

  const maybePromptPairingNearPhone = (phonePoint) => {
    if (!phonePoint) return;

    // if already selected a machine, don't keep prompting
    if (activePairRef.current?.vehicle) return;

    // don't reprompt if prompt already open
    if (pairPromptRef.current) return;

    const candidates = computePairCandidatesNearPhone(phonePoint);
    if (!candidates.length) return;

    const list = candidates.map((c) => c.vehicle).join(", ");
    const first = candidates[0]?.vehicle;

    setPairPrompt({
      field: null,
      candidates,
      selectedVehicle: first || ""
    });

    if (list) {
      maybeNotify("MetaAg", `I found these machines: ${list}. Which one are you operating?`);
    }
  };

  const confirmPairing = () => {
    if (!pairPrompt?.selectedVehicle) {
      setPairPrompt(null);
      return;
    }

    const next = {
      person: userNameRef.current || "",
      vehicle: pairPrompt.selectedVehicle,
      confirmedAt: nowIso()
    };

    setActivePair(next);
    setPairPrompt(null);

    // If the phone is already in a field and the selected machine is also in that field,
    // mark it as power unit immediately for this visit.
    const phonePoly = phoneSessionRef.current?.currentPolygon;
    const msess = machineSessionsRef.current?.[next.vehicle];
    if (phonePoly && msess?.currentPolygon === phonePoly) {
      phoneSessionRef.current.powerUnit = next.vehicle;
    }
  };

  const clearPairing = () => {
    setActivePair(null);
    setPairPrompt(null);
    phoneSessionRef.current.powerUnit = null;
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

    console.log("[GPS] Starting phone/device geolocation watch...");

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setPosition({ lat, lng });

        const phonePoint = { lat, lng };
        const matched = checkInsidePolygon([lng, lat], polygons);

        const session = phoneSessionRef.current;
        session.lastPoint = { lat, lng };

        // record for map markers/trail
        recordPhonePoint(phonePoint);

        // Proximity-based pairing prompt (inside or outside fields)
        maybePromptPairingNearPhone(phonePoint);

        sessionizePoint({
          session,
          matchedPolygon: matched,
          onEnter: (poly, entryIso) => {
            console.log("[GPS] Phone ENTER field:", poly, "at", entryIso);
            setCurrentPolygon(poly);
            setEntryTime(entryIso);
            setExitTime(null);

            // If a machine is already selected and it's also in this field, mark it as power unit for this visit.
            const ap = activePairRef.current;
            const msess = ap?.vehicle ? machineSessionsRef.current?.[ap.vehicle] : null;
            phoneSessionRef.current.powerUnit = msess?.currentPolygon === poly ? ap.vehicle : null;
          },
          onComplete: (visit) => {
            console.log("[GPS] Phone EXIT field:", visit.polygon, "entry:", visit.entryTime, "exit:", visit.exitTime);
            setExitTime(visit.exitTime);

            // Capture powerUnit BEFORE clearing it (used as paired vehicle for this visit)
            const pairedVehicle = phoneSessionRef.current?.powerUnit || null;

            setCurrentPolygon(null);

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

            // Clear power unit after we finalize this visit record
            phoneSessionRef.current.powerUnit = null;

            // Force chatbots to refresh their internal state after a completed visit
            setChatbotResetKey((k) => k + 1);
          }
        });
      },
      (err) => console.error("[GPS] Geolocation error:", err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => {
      console.log("[GPS] Stopping phone/device geolocation watch.");
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
      const forcedSubject = FORCE_GPS_SUBJECT; // ✅ you said: for sure

      setNatsUsingSubject(forcedSubject);
      setNatsError("");
      setNatsStatus("connecting");
      setNatsSubStatus("subscribing");

      console.log("[NATS][App] shouldUseNatsMachines=true. Attempting connect...");
      console.log("[NATS][App] URL from env (hidden):", cfg?.url ? "(set)" : "(missing)");
      console.log("[NATS][App] SUBSCRIBE SUBJECT (forced):", forcedSubject);

      try {
        await connectNats({ url: cfg.url, name: `metaag-2o-ui:${userId || "anon"}` });
        setNatsStatus("connected");
        console.log("[NATS][App] Connected OK. Now subscribing...");

        unsubscribe = await subscribeJson({
          subject: forcedSubject,
          // IMPORTANT: natsService may call onMessage(msg) OR onMessage(msg, subject, raw)
          onMessage: (msg, subject, raw) => {
            // ✅ PROVE reception
            setNatsMsgCount((c) => c + 1);
            setNatsLastSubject(String(subject || ""));
            setNatsLastMsgAt(nowIso());

            // preview helps confirm traffic even if parsing/mapping is wrong
            const preview = (() => {
              try {
                if (raw && typeof raw === "string") return raw.slice(0, 220);
                return JSON.stringify(msg).slice(0, 220);
              } catch {
                return "[unpreviewable]";
              }
            })();
            setNatsLastMsgPreview(preview);

            console.log("[NATS][RX]", { subject, msg });

            const vehicle = String(
              msg?.deviceId ??
                msg?.device_id ??
                msg?.machineId ??
                msg?.machine_id ??
                msg?.device ??
                msg?.vehicle ??
                msg?.machine ??
                msg?.vehicleName ??
                msg?.name ??
                ""
            ).trim();

            const lat = Number(msg?.lat ?? msg?.latitude);
            const lng = Number(msg?.lng ?? msg?.lon ?? msg?.long ?? msg?.longitude);

            const tsRaw = msg?.time ?? msg?.ts ?? msg?.timestamp ?? null;
            const tsIso = tsRaw ? new Date(tsRaw).toISOString() : new Date().toISOString();

            // If it's not a GPS payload, ignore (but you still counted it in diagnostics)
            if (!vehicle || !isFinite(lat) || !isFinite(lng)) return;

            // record for map markers/trail (all machine points)
            recordMachinePoint(vehicle, { lat, lng });

            // Option A: recompute nearby machines when a machine GPS arrives (phone may be stationary)
            const phoneLast = phoneSessionRef.current?.lastPoint;
            if (phoneLast) maybePromptPairingNearPhone(phoneLast);

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
                  raw: msg,
                  subject: String(subject || "")
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
                console.log("[NATS][Machine] ENTER", vehicle, "field:", poly);

                // If phone is in the same field and this machine is the selected one, mark as power unit
                const phonePoly = phoneSessionRef.current?.currentPolygon;
                const ap = activePairRef.current;
                if (phonePoly && phonePoly === poly && ap?.vehicle === vehicle) {
                  phoneSessionRef.current.powerUnit = vehicle;
                }
              },

              onComplete: (visit) => {
                console.log("[NATS][Machine] EXIT", vehicle, "field:", visit.polygon);
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

        setNatsSubStatus("subscribed");
        console.log("[NATS][App] Subscribed OK:", forcedSubject);
      } catch (e) {
        console.error("[NATS][App] connect/subscribe error:", e);
        setNatsStatus("error");
        setNatsSubStatus("failed");
        setNatsError(String(e?.message || e));
      }
    };

    run();

    return () => {
      console.log("[NATS][App] cleanup: unsubscribing (if active) for subject:", natsUsingSubject);
      setNatsSubStatus((s) => (s === "subscribed" ? "unsubscribed" : s));
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

      console.log("[NATS][Publish] Sending records:", pendingRecords.length);
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

  // --- Map render snapshots (driven by mapVersion) ---
  const phoneTrail = useMemo(() => phoneTrailRef.current.slice(), [mapVersion]);

  const machineTrails = useMemo(() => {
    const store = machineTrailRef.current || {};
    const out = {};
    for (const [v, pts] of Object.entries(store)) out[v] = pts.slice();
    return out;
  }, [mapVersion]);

  const latestMachinePoints = useMemo(() => getLatestMachinePoints(), [mapVersion]);

  const pairedVehicle = activePair?.vehicle || null;
  const pairedTrail = useMemo(() => {
    if (!pairedVehicle) return [];
    return (machineTrailRef.current?.[pairedVehicle] || []).slice();
  }, [mapVersion, pairedVehicle]);

  const pairedLivePoint = useMemo(() => {
    if (!pairedVehicle) return null;
    const pts = machineTrailRef.current?.[pairedVehicle] || [];
    return pts.length ? pts[pts.length - 1] : null;
  }, [mapVersion, pairedVehicle]);

  const currentMachineName = pairedVehicle || gpsFeed[0]?.vehicle || machinesSeen[0] || "—";
  const statusTone =
    natsStatus === "connected"
      ? "#1f7a1f"
      : natsStatus === "connecting"
        ? "#9a6700"
        : natsStatus === "error"
          ? "#b00020"
          : "#666";

  const activeFieldLabel = currentPolygon || gpsFeed[0]?.field || pairPrompt?.field || null;
  const chatbotPromptText = activeFieldLabel
    ? `Hey there, I see you did work in field ${activeFieldLabel}.`
    : "Chatbot prompt will appear when a field visit is detected.";

  // --- Marker icons (Google Maps) ---
  const makeCircleIcon = (fillColor, scale = 5, strokeColor = "#ffffff") => {
    const g = window.google;
    if (g?.maps?.SymbolPath) {
      return {
        path: g.maps.SymbolPath.CIRCLE,
        fillColor,
        fillOpacity: fillColor === "#ffffff" ? 0.92 : 1,
        strokeColor,
        strokeOpacity: 1,
        strokeWeight: 1,
        scale
      };
    }

    const r = Math.max(2, Math.round(scale));
    const size = r * 4;
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="1"/>
      </svg>`
    );
    return `data:image/svg+xml;charset=UTF-8,${svg}`;
  };

  const makePinIcon = (color) => {
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="1.2">
        <path d="M12 22s7-7.2 7-13a7 7 0 0 0-14 0c0 5.8 7 13 7 13z"/>
        <circle cx="12" cy="9" r="2.5" fill="white" stroke="white"/>
      </svg>`
    );
    const url = `data:image/svg+xml;charset=UTF-8,${svg}`;

    const g = window.google;
    if (!g?.maps) return url;

    return {
      url,
      scaledSize: new g.maps.Size(28, 28),
      anchor: new g.maps.Point(14, 28)
    };
  };

  const makeTractorIcon = () => {
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 64 64">
        <circle cx="19" cy="45" r="9" fill="#2d3748" stroke="#ffffff" stroke-width="2"/>
        <circle cx="47" cy="47" r="13" fill="#2d3748" stroke="#ffffff" stroke-width="2"/>
        <circle cx="19" cy="45" r="4" fill="#a0aec0"/>
        <circle cx="47" cy="47" r="6" fill="#a0aec0"/>
        <path d="M13 38h20l6-10h8l4 10h5v7h-7" fill="#f6ad55" stroke="#2d3748" stroke-width="2"/>
        <path d="M30 18h10l5 12H30z" fill="#90cdf4" stroke="#2d3748" stroke-width="2"/>
        <path d="M22 26h8v12h-8z" fill="#f6ad55" stroke="#2d3748" stroke-width="2"/>
      </svg>`
    );
    const url = `data:image/svg+xml;charset=UTF-8,${svg}`;
    const g = window.google;
    if (!g?.maps) return url;
    return {
      url,
      scaledSize: new g.maps.Size(36, 36),
      anchor: new g.maps.Point(18, 24)
    };
  };

  const pointIsInsideField = (pt) => {
    if (!pt) return false;
    return !!checkInsidePolygon([pt.lng, pt.lat], polygons);
  };

  // Map shortcut
  if (window.location.hash === "#map") return <FieldMap />;

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        background: "#eef3e8",
        overflow: "hidden",
        position: "relative"
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 14,
          width: "100%",
          height: "100%",
          padding: 14,
          boxSizing: "border-box"
        }}
      >
        <div
          style={{
            width: "26%",
            minWidth: 290,
            maxWidth: 380,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 0
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #d6decf",
              borderRadius: 14,
              padding: 14,
              boxShadow: "0 8px 22px rgba(0,0,0,0.08)"
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: "#4e5b47", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Activity prompt
            </div>
            <div style={{ marginTop: 8, fontSize: 18, fontWeight: 600, lineHeight: 1.35 }}>{chatbotPromptText}</div>
            <button
              type="button"
              onClick={() => alert("Use the chatbot panel below to log activity.")}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "12px 14px",
                borderRadius: 10,
                border: "1px solid #1f4d2c",
                background: "#1f4d2c",
                color: "#fff",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              Log Activity
            </button>
          </div>

          <div
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
              background: "#ffffff",
              border: "1px solid #d6decf",
              borderRadius: 14,
              boxShadow: "0 8px 22px rgba(0,0,0,0.08)"
            }}
          >
            <div style={{ padding: "12px 14px 0", fontWeight: 700, color: "#243120" }}>Assistant</div>
            <div style={{ position: "relative", height: "calc(100% - 40px)", minHeight: 340 }}>
              {mode === "personal" ? (
                <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                  <div style={{ position: "absolute", inset: 0, background: "#fff" }} />
                  <Chatbot key={`cb_${chatbotResetKey}`} apiKey={process.env.REACT_APP_OPENAI_API_KEY} />
                </div>
              ) : mode === "enterprise" && isEnterpriseAuthed ? (
                <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                  <EnterpriseChatbotRAG
                    key={`ecb_${chatbotResetKey}`}
                    userId={userId}
                    userName={userName}
                    onOperationFinalized={(payload) => {
                      console.log("Enterprise operation finalized:", payload);
                    }}
                  />
                </div>
              ) : (
                <div style={{ padding: 14, color: "#555", fontSize: 14 }}>
                  Login on the right panel to enable enterprise activity logging.
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 12
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "#ffffff",
              border: "1px solid #d6decf",
              borderRadius: 14,
              padding: "12px 16px",
              boxShadow: "0 8px 22px rgba(0,0,0,0.08)"
            }}
          >
            <div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#1a2517" }}>MetaAg</div>
              <div style={{ fontSize: 13, color: "#52614a" }}>Tablet layout with live machine and field status</div>
            </div>
            <div style={{ fontSize: 13, color: "#52614a", textAlign: "right" }}>
              <div><strong>Mode:</strong> {mode}</div>
              <div><strong>Field:</strong> {activeFieldLabel || "Outside all fields"}</div>
            </div>
          </div>

          <div
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
              background: "#ffffff",
              border: "1px solid #d6decf",
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 8px 22px rgba(0,0,0,0.08)"
            }}
          >
            <LoadScript googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_API_KEY}>
              <GoogleMap mapContainerStyle={containerStyle} center={position || pairedLivePoint || defaultCenter} zoom={17}>
                {polygonPaths.map((path, i) => (
                  <Polygon
                    key={i}
                    paths={path}
                    options={{
                      strokeColor: "#e0b700",
                      fillColor: "#f8ef9d",
                      strokeWeight: 3,
                      fillOpacity: 0.14
                    }}
                  />
                ))}

                {position && <Marker position={position} icon={makePinIcon("#1e88e5")} title="Browser / device GPS" />}

                {phoneTrail.map((pt, idx) => (
                  <Marker
                    key={`phonept_${idx}`}
                    position={pt}
                    icon={makeCircleIcon("#1e88e5", 2)}
                    clickable={false}
                  />
                ))}

                {Object.entries(machineTrails).map(([vehicle, pts]) =>
                  pts.map((pt, idx) => {
                    const inside = pointIsInsideField(pt);
                    return (
                      <Marker
                        key={`mpt_${vehicle}_${idx}`}
                        position={pt}
                        icon={makeCircleIcon(inside ? "#d62828" : "#ffffff", 3, inside ? "#ffffff" : "#555555")}
                        clickable={false}
                      />
                    );
                  })
                )}

                {latestMachinePoints.map(({ vehicle, point }) => {
                  const isPaired = pairedVehicle && vehicle === pairedVehicle;
                  return (
                    <Marker
                      key={`mlive_${vehicle}`}
                      position={point}
                      icon={makeTractorIcon()}
                      title={isPaired ? `Paired: ${vehicle}` : `Seen: ${vehicle}`}
                    />
                  );
                })}

                {phoneTrail.length > 1 && (
                  <Polyline
                    path={phoneTrail}
                    options={{
                      strokeColor: "#1e88e5",
                      strokeOpacity: 0.9,
                      strokeWeight: 3
                    }}
                  />
                )}

                {pairedTrail.length > 1 && (
                  <Polyline
                    path={pairedTrail}
                    options={{
                      strokeColor: "#d62828",
                      strokeOpacity: 0.95,
                      strokeWeight: 3
                    }}
                  />
                )}
              </GoogleMap>
            </LoadScript>

            <div
              style={{
                position: "absolute",
                left: 12,
                bottom: 12,
                background: "rgba(255,255,255,0.95)",
                borderRadius: 12,
                padding: "10px 12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
                fontSize: 12,
                lineHeight: 1.4,
                maxWidth: 260
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Map legend</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ width: 12, height: 12, borderRadius: 999, background: "#f8ef9d", border: "2px solid #e0b700", display: "inline-block" }} />
                <span>Field boundary</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ width: 12, height: 12, borderRadius: 999, background: "#d62828", display: "inline-block" }} />
                <span>Point inside field</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ width: 12, height: 12, borderRadius: 999, background: "#ffffff", border: "1px solid #555", display: "inline-block" }} />
                <span>Point outside field</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>🚜</span>
                <span>Latest machine marker</span>
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            width: "28%",
            minWidth: 320,
            maxWidth: 420,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 0
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #d6decf",
              borderRadius: 14,
              padding: 16,
              boxShadow: "0 8px 22px rgba(0,0,0,0.08)",
              overflow: "auto"
            }}
          >
            <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 12 }}>MetaAg</div>

            <div style={{ display: "grid", gap: 10, fontSize: 15 }}>
              <div>
                <strong>Status:</strong>{" "}
                <span style={{ color: statusTone, fontWeight: 700 }}>{natsStatus}</span>
                {natsError ? <div style={{ color: "#b00020", marginTop: 4 }}>{natsError}</div> : null}
              </div>
              <div><strong>Machine:</strong> {currentMachineName}</div>
              <div>
                <strong>Location:</strong>{" "}
                {position
                  ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`
                  : gpsFeed[0]
                    ? `${gpsFeed[0].lat.toFixed(5)}, ${gpsFeed[0].lng.toFixed(5)}`
                    : "Waiting for GPS..."}
              </div>
              <div><strong>NATS subject:</strong> {natsUsingSubject}</div>
              <div><strong>Messages seen:</strong> {natsMsgCount}</div>
              {natsLastMsgAt ? <div><strong>Last msg at:</strong> {new Date(natsLastMsgAt).toLocaleTimeString()}</div> : null}
              {natsLastSubject ? <div><strong>Last subject:</strong> {natsLastSubject}</div> : null}
              <div><strong>Machines seen:</strong> {machinesSeen.length}</div>
              {currentPolygon ? (
                <div>
                  <strong>Inside:</strong> {currentPolygon}
                  <br />
                  <strong>Entry Time:</strong> {entryTime ? new Date(entryTime).toLocaleTimeString() : ""}
                </div>
              ) : exitTime ? (
                <div>
                  <strong>Exited:</strong> {new Date(exitTime).toLocaleTimeString()}
                </div>
              ) : null}
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={{ fontWeight: 700, fontSize: 14 }}>
                Mode:{" "}
                <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ marginLeft: 6 }}>
                  <option value="personal">Personal</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </label>
            </div>

            {mode === "enterprise" && (
              <div style={{ marginTop: 14 }}>
                {isEnterpriseAuthed ? (
                  <div style={{ fontSize: 14 }}>
                    <div><strong>User:</strong> {userName}</div>
                    <div style={{ marginTop: 8 }}>
                      <strong>My GPS:</strong>{" "}
                      {position ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : "Locating..."}
                    </div>

                    {activePair ? (
                      <div style={{ marginTop: 10, padding: 10, border: "1px solid #ddd", borderRadius: 8 }}>
                        <div><strong>Paired:</strong> {activePair.vehicle}</div>
                        <button type="button" onClick={clearPairing} style={{ marginTop: 8, width: "100%" }}>
                          Change / Clear pairing
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop: 10, fontSize: 12, color: "#555" }}>
                        Pairing will be requested when your phone and a machine are in the same field.
                      </div>
                    )}

                    <button type="button" onClick={handleLogout} style={{ marginTop: 12, width: "100%" }}>
                      Logout
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 14 }}>
                    <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                      <button
                        type="button"
                        onClick={() => {
                          setAuthTab("login");
                          setAuthError("");
                        }}
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
                        onClick={() => {
                          setAuthTab("register");
                          setAuthError("");
                        }}
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
                      style={{ width: "100%", padding: "0.5rem", marginBottom: "0.5rem", fontSize: "16px", boxSizing: "border-box" }}
                    />
                    <input
                      type="password"
                      value={authPasskey}
                      onChange={(e) => setAuthPasskey(e.target.value)}
                      placeholder="Passkey"
                      style={{ width: "100%", padding: "0.5rem", marginBottom: "0.5rem", fontSize: "16px", boxSizing: "border-box" }}
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

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #d6decf",
              borderRadius: 14,
              padding: 14,
              boxShadow: "0 8px 22px rgba(0,0,0,0.08)",
              overflow: "auto",
              minHeight: 0
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Live GPS messages ({gpsFeed.length})</div>
            <div
              style={{
                border: "1px solid #ddd",
                borderRadius: 10,
                padding: 8,
                maxHeight: 190,
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
                      {m.raw?.status !== undefined ? <span style={{ color: "#666" }}> • status: {m.raw.status}</span> : null}
                      {m.raw?.mode !== undefined ? <span style={{ color: "#666" }}> • mode: {m.raw.mode}</span> : null}
                      {m.raw?.class ? <span style={{ color: "#666" }}> • class: {m.raw.class}</span> : null}
                    </div>
                    {m.subject ? <div style={{ color: "#777", marginTop: 2 }}>subject: {m.subject}</div> : null}
                  </div>
                ))
              )}
            </div>

            <div style={{ marginTop: 12, padding: 10, border: "1px solid #ddd", borderRadius: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>NATS Debug</div>
              <div style={{ fontSize: 12 }}>
                <div><strong>Sub status:</strong> {natsSubStatus}</div>
                <div><strong>Subject:</strong> {natsUsingSubject}</div>
                <div><strong>Msgs seen:</strong> {natsMsgCount}</div>
                {natsLastMsgPreview ? (
                  <div style={{ marginTop: 4 }}>
                    <strong>Last preview:</strong>
                    <div style={{ whiteSpace: "pre-wrap", color: "#555" }}>{natsLastMsgPreview}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {pairPrompt ? (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 18,
            transform: "translateX(-50%)",
            background: "rgba(255, 255, 255, 0.97)",
            padding: "1rem",
            borderRadius: "12px",
            boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
            zIndex: 1100,
            maxWidth: 440,
            width: "calc(100% - 32px)"
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Confirm machine</div>
          <div style={{ fontSize: 14, marginBottom: 10 }}>
            I found these machines nearby. Which one are you operating?
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
                  {c.field ? ` • IN: ${c.field}` : " • OUTSIDE"}
                  {isFinite(c.distanceM) ? ` • ≈ ${Math.round(c.distanceM)}m` : ""}
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
    </div>
  );
}

export default App;
