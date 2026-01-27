import React, { useEffect, useRef, useState } from "react";
import { GoogleMap, LoadScript, Marker, Polygon } from "@react-google-maps/api";
import polygons from "./data/polygons.json";
import { checkInsidePolygon } from "./geo/geo";
import { saveVisit, getUnsentVisits } from "./storage";
import Chatbot from "./components/Chatbot";
import EnterpriseChatbotRAG from "./components/EnterpriseChatbotRAG";
import FieldMap from "./components/FieldMap";

import {
  saveEnterpriseVisit,
  getEnterpriseVisits,
  registerEnterpriseUser,
  loginEnterpriseUser
} from "./enterpriseStorage";

const containerStyle = { width: "100vw", height: "100vh" };
const defaultCenter = { lat: 40.421, lng: -86.916 };

const LS_USER_ID = "enterprise_userId";
const LS_USER_NAME = "enterprise_userName";

/** ---- NEW: visit sessionization knobs ---- */
const EXIT_GRACE_MS = 30_000;      // must stay outside for 30s to count as a real exit
const MIN_VISIT_SECONDS = 20;      // ignore visits shorter than 20s (jitter fragments)
/** ---------------------------------------- */

function App() {
  const [position, setPosition] = useState(null);
  const [currentPolygon, setCurrentPolygon] = useState(null);
  const [entryTime, setEntryTime] = useState(null);
  const [exitTime, setExitTime] = useState(null);
  const [mode, setMode] = useState("enterprise"); // or "personal"

  const [userId, setUserId] = useState(() => localStorage.getItem(LS_USER_ID) || "");
  const [userName, setUserName] = useState(() => localStorage.getItem(LS_USER_NAME) || "");

  const [authTab, setAuthTab] = useState("login");
  const [authName, setAuthName] = useState("");
  const [authPasskey, setAuthPasskey] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const isEnterpriseAuthed = mode !== "enterprise" ? true : !!(userId && userName);

  /** ---- NEW: refs to manage exit debounce ---- */
  const exitTimerRef = useRef(null);
  const pendingExitAtRef = useRef(null);
  /** ------------------------------------------ */

  const clearExitTimer = () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = null;
    pendingExitAtRef.current = null;
  };

  const handleLogout = () => {
    localStorage.removeItem(LS_USER_ID);
    localStorage.removeItem(LS_USER_NAME);
    setUserId("");
    setUserName("");
    setAuthName("");
    setAuthPasskey("");
    setAuthError("");
    setAuthTab("login");
  };

  const handleRegister = async () => {
    setAuthError("");
    setAuthBusy(true);
    try {
      const res = await registerEnterpriseUser(authName, authPasskey);
      if (!res?.userId) {
        setAuthError("Registration failed. Please try again.");
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
      setAuthError("Registration failed. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogin = async () => {
    setAuthError("");
    setAuthBusy(true);
    try {
      const res = await loginEnterpriseUser(authName, authPasskey);
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
      setAuthError("Login failed. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  };

  // -------- background tracking (FIXED: debounce exit + minimum duration) --------
  useEffect(() => {
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setPosition({ lat, lng });

        const matched = checkInsidePolygon([lng, lat], polygons);

        // CASE 1: we are inside a polygon
        if (matched) {
          // If we were in exit grace (GPS briefly outside), cancel the pending exit
          if (currentPolygon && exitTimerRef.current) {
            clearExitTimer();
          }

          // Enter a new polygon (or first time)
          if (matched !== currentPolygon) {
            clearExitTimer(); // safety
            setCurrentPolygon(matched);
            const now = new Date().toISOString();
            setEntryTime(now);
            setExitTime(null);
          }

          return;
        }

        // CASE 2: not inside any polygon
        if (!matched && currentPolygon) {
          // Start exit grace timer only once
          if (!exitTimerRef.current) {
            const exitStartedAt = new Date().toISOString();
            pendingExitAtRef.current = exitStartedAt;

            exitTimerRef.current = setTimeout(() => {
              const finalExit = new Date().toISOString();

              // compute duration safely using the latest known entryTime
              const entry = entryTime;
              const durSeconds = entry ? (new Date(finalExit) - new Date(entry)) / 1000 : 0;

              // Filter fragmented exits / micro-visits
              if (durSeconds >= MIN_VISIT_SECONDS) {
                const visit = {
                  polygon: currentPolygon,
                  entryTime: entry,
                  exitTime: finalExit
                };

                if (mode === "enterprise") {
                  if (userId) {
                    console.log("📦 Saving visit to Firebase (enterprise user):", userId, visit);
                    saveEnterpriseVisit(userId, visit);
                  } else {
                    console.log("ℹ️ Enterprise mode active but not logged in yet; visit not saved.");
                  }
                } else {
                  console.log("📦 Saving visit to Airtable/localStorage:", visit);
                  saveVisit(visit);
                }

                setExitTime(finalExit);
              } else {
                console.log(
                  "🗑️ Ignoring fragmented visit:",
                  { polygon: currentPolygon, durSeconds, entry, exit: finalExit }
                );
              }

              // finalize leaving state
              setCurrentPolygon(null);
              clearExitTimer();
            }, EXIT_GRACE_MS);
          }
        }
      },
      (err) => console.error("Geolocation error:", err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearExitTimer();
    };
  }, [currentPolygon, mode, entryTime, userId]);

  // Convert GeoJSON polygon to Google Maps format
  const polygonPaths = polygons.features.map((feature) =>
    feature.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }))
  );

  return window.location.hash === "#map" ? (
    <FieldMap />
  ) : (
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

      {/* top-right overlay (unchanged) */}
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
          maxWidth: "320px"
        }}
      >
        <h3 style={{ marginTop: 0 }}>MetaAg 2o</h3>

        <div style={{ marginBottom: "1rem" }}>
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
                <button
                  type="button"
                  onClick={handleLogout}
                  style={{ marginTop: "0.5rem", width: "100%" }}
                >
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

                {authError && (
                  <div style={{ color: "#b00020", marginBottom: "0.5rem" }}>
                    {authError}
                  </div>
                )}

                {authTab === "login" ? (
                  <button
                    type="button"
                    onClick={handleLogin}
                    disabled={authBusy}
                    style={{ width: "100%", fontSize: "16px" }}
                  >
                    {authBusy ? "Logging in..." : "Login"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleRegister}
                    disabled={authBusy}
                    style={{ width: "100%", fontSize: "16px" }}
                  >
                    {authBusy ? "Registering..." : "Register"}
                  </button>
                )}

                <div style={{ marginTop: "0.5rem", color: "#555" }}>
                  {authTab === "register"
                    ? "Register once, then use the same name + passkey to login on this device."
                    : "Login to start enterprise logging (visits will be saved under your name)."}
                </div>
              </div>
            )}
          </div>
        )}

        {currentPolygon && (
          <div>
            <strong>Inside:</strong> {currentPolygon}
            <br />
            <strong>Entry Time:</strong>{" "}
            {entryTime ? new Date(entryTime).toLocaleTimeString() : ""}
          </div>
        )}

        {!currentPolygon && exitTime && (
          <div>
            <strong>Exited:</strong> {new Date(exitTime).toLocaleTimeString()}
            <br />
            <strong>Location:</strong>
            <br />
            {position ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : "Locating..."}
          </div>
        )}

        <div style={{ marginTop: "1rem" }}>
          <button
            onClick={async () => {
              const logs =
                mode === "enterprise"
                  ? isEnterpriseAuthed
                    ? await getEnterpriseVisits(userId)
                    : []
                  : getUnsentVisits();
              alert(JSON.stringify(logs, null, 2));
            }}
          >
            Show {mode === "enterprise" ? "Enterprise" : "Personal"} Logs
          </button>
        </div>
      </div>

      {mode === "enterprise" ? (
        isEnterpriseAuthed ? (
          <EnterpriseChatbotRAG userId={userId} userName={userName} />
        ) : null
      ) : (
        <Chatbot apiKey={process.env.REACT_APP_OPENAI_API_KEY} />
      )}
    </LoadScript>
  );
}

export default App;
