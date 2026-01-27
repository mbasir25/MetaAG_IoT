import React, { useEffect, useState } from "react";
import {
  GoogleMap,
  LoadScript,
  Marker,
  Polygon
} from "@react-google-maps/api";
import polygons from "./data/polygons.json";
import { checkInsidePolygon } from "./geo/geo";
import { saveVisit } from "./storage";
import { getUnsentVisits } from "./storage";
import Chatbot from "./components/Chatbot";
// import EnterpriseChatbot from "./components/EnterpriseChatbot";
import EnterpriseChatbotRAG from './components/EnterpriseChatbotRAG';
import { saveEnterpriseVisit, getEnterpriseVisits } from "./enterpriseStorage";
import FieldMap from "./components/FieldMap";

const containerStyle = {
  width: "100vw",
  height: "100vh"
};

const defaultCenter = { lat: 40.4210, lng: -86.9160 };

function App() {
  const [position, setPosition] = useState(null);
  const [currentPolygon, setCurrentPolygon] = useState(null);
  const [entryTime, setEntryTime] = useState(null);
  const [exitTime, setExitTime] = useState(null);
  const [mode, setMode] = useState("enterprise"); // or "personal"

  useEffect(() => {
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setPosition({ lat, lng });

        const matched = checkInsidePolygon([lng, lat], polygons);
        if (matched && matched !== currentPolygon) {
          setCurrentPolygon(matched);
          setEntryTime(new Date().toISOString());
          setExitTime(null);
        } else if (!matched && currentPolygon) {
          const time = new Date().toISOString();
          setExitTime(time);

          const visit = {
            polygon: currentPolygon,
            entryTime,
            exitTime: time
          };

          if (mode === "enterprise") {
            console.log("📦 Saving visit to Firebase:", visit);
            saveEnterpriseVisit(visit);
          } else {
            console.log("📦 Saving visit to Airtable/localStorage:", visit);
            saveVisit(visit);
          }

          setCurrentPolygon(null);
        }
      },
      (err) => console.error("Geolocation error:", err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [currentPolygon, mode, entryTime]);

  // Convert GeoJSON polygon to Google Maps format
  const polygonPaths = polygons.features.map((feature) =>
    feature.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }))
  );

  return window.location.hash === "#map" ? (
    <FieldMap />
  ) : (
    <LoadScript googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_API_KEY}>
      <GoogleMap
        mapContainerStyle={containerStyle}
        center={position || defaultCenter}
        zoom={17}
      >
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

      <div style={{
        position: "absolute",
        top: 10,
        right: 10,
        background: "rgba(255, 255, 255, 0.9)", // white with 80% opacity
        padding: "1rem",
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        zIndex: 1000,
        maxWidth: "300px"
      }}>
        <h3>MetaAg 2o</h3>

        <div style={{ marginBottom: "1rem" }}>
          <label>
            Mode:{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="personal">Personal</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>
        </div>

        {currentPolygon && (
          <div>
            <strong>Inside:</strong> {currentPolygon}<br />
            <strong>Entry Time:</strong> {new Date(entryTime).toLocaleTimeString()}
          </div>
        )}

        {!currentPolygon && exitTime && (
          <div>
            <strong>Exited:</strong> {new Date(exitTime).toLocaleTimeString()}<br />
            <strong>Location:</strong><br />
            {position ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : "Locating..."}
          </div>
        )}

        <div style={{ marginTop: "1rem" }}>
          <button
            onClick={async () => {
              const logs =
                mode === "enterprise"
                  ? await getEnterpriseVisits()
                  : getUnsentVisits();
              alert(JSON.stringify(logs, null, 2));
            }}
          >
            Show {mode === "enterprise" ? "Enterprise" : "Personal"} Logs
          </button>
        </div>
      </div>

      {mode === "enterprise" ? (
        <EnterpriseChatbotRAG />
      ) : (
        <Chatbot apiKey={process.env.REACT_APP_OPENAI_API_KEY} />
      )}
    </LoadScript>
  );

}

export default App;
