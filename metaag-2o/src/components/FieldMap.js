import React, { useEffect, useMemo, useState } from 'react';
import { GoogleMap, LoadScript, Polygon, InfoWindow } from '@react-google-maps/api';
import { db } from '../firebase';
import { ref, get } from 'firebase/database';
import polygons from '../data/polygons.json';
import { polygonCentroid, findFeatureByName } from '../geo/geo';
import botIcon from '../assets/bot-icon.png';
import userIcon from '../assets/user-icon.png';
import { fetchCurrent, fetchWeatherByDateRange } from '../services/weather';
import { extractDates } from '../utils/dateUtiles.js';

const containerStyle = { width: '100vw', height: '100vh' };
const defaultCenter = { lat: 40.421, lng: -86.916 };

// -------- geometry helpers (Polygon + MultiPolygon safe) --------
const featureToRings = (feature) => {
  const type = feature?.geometry?.type;
  const coords = feature?.geometry?.coordinates;
  if (!type || !coords) return [];
  if (type === 'Polygon') return coords; // [ring1, ring2...]
  if (type === 'MultiPolygon') return coords; // [[ring1...],[ring1...],...]
  return [];
};

const ringLngLatToPath = (ring) => ring.map(([lng, lat]) => ({ lat, lng }));

const buildPolygonRenderData = (geojson) => {
  const out = [];
  for (const feature of geojson?.features || []) {
    const name = feature?.properties?.name;
    if (!name) continue;

    const type = feature?.geometry?.type;
    const ringsOrPolys = featureToRings(feature);

    if (type === 'Polygon') {
      const rings = Array.isArray(ringsOrPolys) ? ringsOrPolys : [];
      if (!rings.length) continue;
      out.push({ name, paths: rings.map(ringLngLatToPath) }); // LatLng[][] supports holes
      continue;
    }

    if (type === 'MultiPolygon') {
      const polys = Array.isArray(ringsOrPolys) ? ringsOrPolys : [];
      let polyIndex = 0;
      for (const polyRings of polys) {
        if (!Array.isArray(polyRings) || !polyRings.length) continue;
        out.push({
          name,
          subKey: `${name}__${polyIndex++}`,
          paths: polyRings.map(ringLngLatToPath),
        });
      }
    }
  }
  return out;
};

// Choose a representative ring for centroid (outer ring of the largest polygon)
const getBestOuterRing = (feature) => {
  const type = feature?.geometry?.type;
  const coords = feature?.geometry?.coordinates;
  if (!type || !coords) return null;

  const ringAreaAbs = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2);
  };

  if (type === 'Polygon') return coords?.[0] || null;

  if (type === 'MultiPolygon') {
    let best = null;
    let bestArea = 0;
    for (const poly of coords || []) {
      const outer = poly?.[0];
      const a = ringAreaAbs(outer);
      if (a > bestArea) {
        bestArea = a;
        best = outer;
      }
    }
    return best;
  }

  return null;
};

const FieldMap = () => {
  const [operationData, setOperationData] = useState({});
  const [selectedField, setSelectedField] = useState(null);
  const [selectedActivity, setSelectedActivity] = useState(null);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [userInput, setUserInput] = useState('');

  // Fetch operations grouped by field
  useEffect(() => {
    const fetchOperations = async () => {
      const snapshot = await get(ref(db, 'Operations'));
      if (!snapshot.exists()) return;

      const rawData = snapshot.val();
      const logs = Object.values(rawData);
      const grouped = {};
      for (const log of logs) {
        if (!log?.Fieldname) continue;
        if (!grouped[log.Fieldname]) grouped[log.Fieldname] = [];
        grouped[log.Fieldname].push(log);
      }
      setOperationData(grouped);
    };

    fetchOperations();
  }, []);

  // Build polygon render data (Polygon + MultiPolygon safe)
  const polygonRenderData = useMemo(() => buildPolygonRenderData(polygons), []);

  // Stable global activity -> color map
  const activityColorMap = useMemo(() => {
    const palette = ['#FF5733', '#33A1FF', '#4CAF50', '#FFB300', '#9C27B0', '#795548', '#00BCD4', '#E91E63'];
    const allActs = [];
    for (const ops of Object.values(operationData || {})) {
      for (const op of ops || []) {
        const a = String(op?.Activity || '').trim();
        if (a) allActs.push(a);
      }
    }
    const uniq = Array.from(new Set(allActs)).sort((a, b) => a.localeCompare(b));
    const map = {};
    uniq.forEach((a, i) => {
      map[a] = palette[i % palette.length];
    });
    return map;
  }, [operationData]);

  // Color by number of unique activities on a field (bucket)
  const activityCountBucketColor = (count) => {
    if (count <= 0) return '#CCCCCC';
    if (count === 1) return null; // use activityColorMap for the single activity
    if (count === 2) return '#FFB300';
    if (count === 3) return '#9C27B0';
    return '#4CAF50';
  };

  // Try to find a field name mentioned in text
  const extractFieldName = (text, selectedFieldName, operationDataLocal) => {
    if (selectedFieldName) return selectedFieldName;

    for (const f of polygons.features) {
      const nm = f?.properties?.name;
      if (!nm) continue;
      const re = new RegExp(`\\b${nm}\\b`, 'i');
      if (re.test(text)) return nm;
    }
    for (const k of Object.keys(operationDataLocal || {})) {
      const re = new RegExp(`\\b${k}\\b`, 'i');
      if (re.test(text)) return k;
    }
    return null;
  };

  // YYYY-MM-DD from Entry/Exit (local date)
  const opDate = (op) => {
    const raw = op?.Entry || op?.Exit;
    if (!raw) return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const attachWeatherToOps = (ops, dailyByDate) => {
    const normalized = {};
    Object.entries(dailyByDate || {}).forEach(([d, val]) => {
      normalized[String(d).toLowerCase()] = val;
    });

    return (ops || []).map((op) => {
      const d = opDate(op);
      if (!d) return { ...op, _date: null, weather: null };
      const key = d.toLowerCase();
      return { ...op, _date: key, weather: normalized[key] || null };
    });
  };

  const getFieldCentroid = (fieldName) => {
    const feature = findFeatureByName(polygons, fieldName);
    if (!feature) return null;

    const ring = getBestOuterRing(feature);
    if (!ring || ring.length < 3) return null;

    return polygonCentroid(ring); // { lat, lng }
  };

  // ---- OpenAI helper (robust) ----
  const openAIChat = async ({ messages, temperature = 0.7 }) => {
    const apiKey = process.env.REACT_APP_OPENAI_API_KEY;
    if (!apiKey) {
      return { ok: false, error: 'Missing REACT_APP_OPENAI_API_KEY in the frontend build.' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.message || `OpenAI request failed (${response.status})`;
      console.error('OpenAI error:', data);
      return { ok: false, error: msg };
    }

    const content = data?.choices?.[0]?.message?.content || '';
    return { ok: true, content };
  };

  const formatGPTResponse = (text) => {
    const s = String(text || '').trim();
    if (!s) return ['No response.'];
    return s.split('\n').map((l) => l.trim()).filter(Boolean);
  };

  // Chart generator (Chart.js config -> QuickChart image)
  const generateGraphWithGPT = async (userText, opData, weatherContext) => {
    try {
      const prompt = `
You are a data visualization generator.
You receive a JSON object "operationData" (farm operations) and optionally "weatherContext".
Return ONLY a valid JSON Chart.js configuration (no code block, no text).
The chart should directly answer the user's request.
`.trim();

      const { ok, content, error } = await openAIChat({
        temperature: 0.3,
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `operationData = ${JSON.stringify(opData)}; weatherContext = ${JSON.stringify(weatherContext)}; user request: ${userText}`,
          },
        ],
      });

      if (!ok) throw new Error(error || 'OpenAI error');

      let chartText = String(content || '').trim().replace(/```(json)?/g, '').trim();

      let chartConfig;
      try {
        chartConfig = JSON.parse(chartText);
      } catch (err) {
        console.error('Chart JSON parse error:', chartText);
        throw new Error('Invalid JSON from GPT');
      }

      const url = `https://quickchart.io/chart?width=900&height=480&format=png&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`QuickChart error: ${res.status}`);
      const buf = await res.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      return `<img src="data:image/png;base64,${base64}" alt="Generated Graph" />`;
    } catch (error) {
      console.error('Graph generation error:', error);
      return 'Sorry, I couldn’t generate that chart.';
    }
  };

  // Build weather context for a field + date window
  const buildWeatherContextForField = async ({ fieldName, userText }) => {
    const centroid = getFieldCentroid(fieldName);
    if (!centroid) return { weatherContext: null, opsWithWeather: null };

    const fieldOps = operationData[fieldName] || [];
    const dateRange = extractDates(userText);

    let startISO;
    let endISO;

    if (dateRange?.start && dateRange?.end) {
      startISO = dateRange.start;
      endISO = dateRange.end;
    } else if (fieldOps.length) {
      const dates = fieldOps.map(opDate).filter(Boolean).sort();
      startISO = dates[0] || new Date().toISOString().slice(0, 10);
      endISO = dates[dates.length - 1] || startISO;
    } else {
      const today = new Date().toISOString().slice(0, 10);
      startISO = today;
      endISO = today;
    }

    const wx = await fetchWeatherByDateRange(centroid.lat, centroid.lng, startISO, endISO);
    const opsWithWeather = attachWeatherToOps(fieldOps, wx?.dailyByDate || {});
    const weatherContext = { ...(wx || {}), startISO, endISO, fieldName };
    return { weatherContext, opsWithWeather };
  };

  // Polygon click: select field and preload weather for that field
  const handlePolygonClick = async (fieldName) => {
    const ops = operationData[fieldName] || [];

    let opsWithWeather = null;
    let weatherContext = null;
    try {
      const wx = await buildWeatherContextForField({ fieldName, userText: '' });
      opsWithWeather = wx.opsWithWeather;
      weatherContext = wx.weatherContext;
    } catch (e) {
      console.warn('Weather preload failed:', e);
    }

    setSelectedField({ name: fieldName, ops, opsWithWeather, weatherContext });
    setSelectedActivity(null);
  };

  const handleCardClick = (activityObj) => setSelectedActivity(activityObj);
  const handleCloseDetailPopup = () => setSelectedActivity(null);

  const toggleChat = () => setIsChatOpen((v) => !v);
  const handleCloseChat = () => setIsChatOpen(false);

  const getGPTResponse = async (userText) => {
    try {
      const wantsChart = /\b(chart|plot|graph|visualize|trend)\b/i.test(userText);
      if (wantsChart) {
        const imgHtml = await generateGraphWithGPT(userText, operationData, selectedField?.weatherContext || null);
        return imgHtml;
      }

      const wantsWeather = /\b(weather|rain|precip|temperature|temp|wind|forecast|humidity|snow)\b/i.test(userText);
      const fieldName = extractFieldName(userText, selectedField?.name, operationData);

      let weatherContext = selectedField?.weatherContext || null;
      let opsWithWeather = selectedField?.opsWithWeather || null;

      // If user explicitly asks weather, fetch it for the referenced field & time window
      if (wantsWeather && fieldName) {
        const wx = await buildWeatherContextForField({ fieldName, userText });
        weatherContext = wx.weatherContext;
        opsWithWeather = wx.opsWithWeather;
      }

      // If field referenced but not preloaded, fetch once to integrate (even if no weather keywords)
      if (fieldName && !weatherContext) {
        try {
          const wx = await buildWeatherContextForField({ fieldName, userText: '' });
          weatherContext = wx.weatherContext;
          opsWithWeather = wx.opsWithWeather;
        } catch {
          // ignore
        }
      }

      // Current weather when asked explicitly
      let currentWeather = null;
      if (wantsWeather && fieldName) {
        const centroid = getFieldCentroid(fieldName);
        if (centroid) {
          try {
            currentWeather = await fetchCurrent(centroid.lat, centroid.lng);
          } catch (e) {
            console.warn('Current weather fetch failed:', e);
          }
        }
      }

      const messages = [
        {
          role: 'system',
          content: `
You are an agronomy assistant.
You receive farm operation logs grouped by field, and optional weather context.
If "opsWithWeather" is provided, integrate the weather details into the relevant operations by date.
Be concise and practical. If you cannot find data, say so clearly.
`.trim(),
        },
        {
          role: 'user',
          content: JSON.stringify({
            userInput: userText,
            selectedField: selectedField?.name || null,
            operationData,
            fieldName,
            weatherContext,
            currentWeather,
            opsWithWeather,
          }),
        },
      ];

      const { ok, content, error } = await openAIChat({ messages, temperature: 0.7 });
      if (!ok) return [`OpenAI error: ${error || 'Unknown error'}`];

      return formatGPTResponse(content);
    } catch (err) {
      console.error('GPT error:', err);
      return ['Error connecting to GPT.'];
    }
  };

  const handleUserInput = async () => {
    if (!userInput.trim()) return;

    const input = userInput;
    setChatMessages((prev) => [...prev, { sender: 'user', text: input }]);
    setUserInput('');

    const response = await getGPTResponse(input);

    if (typeof response === 'string' && response.startsWith('<img')) {
      setChatMessages((prev) => [...prev, { sender: 'bot', text: response, isHtml: true }]);
    } else {
      const lines = Array.isArray(response) ? response : [String(response)];
      setChatMessages((prev) => [...prev, { sender: 'bot', text: lines.join('\n') }]);
    }
  };

  const infoAnchor = useMemo(() => {
    if (!selectedField?.name) return defaultCenter;
    const c = getFieldCentroid(selectedField.name);
    return c || defaultCenter;
  }, [selectedField?.name]);

  return (
    <div>
      <LoadScript googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_API_KEY}>
        <GoogleMap mapContainerStyle={containerStyle} center={defaultCenter} zoom={16}>
          {polygonRenderData.map((poly, i) => {
            const ops = operationData[poly.name] || [];
            const activities = Array.from(new Set((ops || []).map((op) => String(op?.Activity || '').trim()).filter(Boolean)));
            const uniqueCount = activities.length;

            let strokeColor = '#CCCCCC';
            let fillColor = '#CCCCCC';

            if (uniqueCount === 1) {
              const a = activities[0];
              strokeColor = activityColorMap[a] || '#33A1FF';
              fillColor = strokeColor;
            } else if (uniqueCount > 1) {
              const bucket = activityCountBucketColor(uniqueCount) || '#FFB300';
              strokeColor = bucket;
              fillColor = bucket;
            }

            return (
              <Polygon
                key={poly.subKey || poly.name || i}
                paths={poly.paths}
                options={{
                  strokeColor,
                  fillColor,
                  strokeOpacity: 0.9,
                  strokeWeight: uniqueCount > 1 ? 3 : 2,
                  fillOpacity: 0.35,
                  clickable: true,
                }}
                onClick={() => handlePolygonClick(poly.name)}
              />
            );
          })}

          {selectedField && (
            <InfoWindow position={infoAnchor} onCloseClick={() => setSelectedField(null)}>
              <div>
                <h4>{selectedField.name}</h4>

                {selectedField.weatherContext?.startISO && (
                  <div style={{ marginBottom: '8px', padding: '6px', border: '1px solid #eee' }}>
                    <strong>Weather window:</strong> {selectedField.weatherContext.startISO} → {selectedField.weatherContext.endISO}
                  </div>
                )}

                {(selectedField.opsWithWeather || selectedField.ops || []).map((op, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleCardClick(op)}
                    style={{ cursor: 'pointer', marginBottom: '10px', border: '1px solid #ddd', padding: '10px' }}
                  >
                    <h5>{op.Activity}</h5>
                    <p>
                      <strong>Entry:</strong> {op.Entry || '—'}
                    </p>
                    <p>
                      <strong>Exit:</strong> {op.Exit || '—'}
                    </p>
                    {op.weather && (
                      <p>
                        <strong>Weather:</strong> {typeof op.weather === 'string' ? op.weather : JSON.stringify(op.weather)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </InfoWindow>
          )}

          {selectedActivity && (
            <InfoWindow position={defaultCenter} onCloseClick={handleCloseDetailPopup}>
              <div>
                <h4>Activity Details</h4>
                {Object.entries(selectedActivity).map(([key, value], index) => (
                  <p key={index}>
                    <strong>{key}:</strong> {value || 'N/A'}
                  </p>
                ))}
              </div>
            </InfoWindow>
          )}
        </GoogleMap>
      </LoadScript>

      <button
        onClick={toggleChat}
        style={{
          position: 'absolute',
          bottom: '30px',
          right: '30px',
          backgroundColor: '#ff4081',
          borderRadius: '50%',
          padding: '20px',
          border: 'none',
          color: 'white',
          fontSize: '24px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
          cursor: 'pointer',
        }}
      >
        💬
      </button>

      {isChatOpen && (
        <div
          style={{
            position: 'fixed',
            bottom: '80px',
            right: '30px',
            width: '60%',
            height: '80%',
            backgroundColor: 'white',
            borderRadius: '10px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              fontSize: '18px',
              fontWeight: 'bold',
              marginBottom: '1px',
              fontFamily: '"Roboto"',
              textAlign: 'center',
              backgroundColor: '#f1f1f1',
            }}
          >
            <h3>I know your Farm activity.</h3>
            <button
              onClick={handleCloseChat}
              style={{
                position: 'absolute',
                top: '10px',
                right: '20px',
                backgroundColor: 'transparent',
                border: 'none',
                fontSize: '24px',
                cursor: 'pointer',
              }}
            >
              ✖
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', marginTop: '10px' }}>
            {chatMessages.map((msg, index) => (
              <div key={index} style={{ display: 'flex', justifyContent: msg.sender === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', margin: '5px' }}>
                  {msg.sender === 'bot' && <img src={botIcon} alt="bot" style={{ width: '30px', marginRight: '10px' }} />}
                  <div
                    style={{
                      backgroundColor: msg.sender === 'user' ? '#007bff' : '#f1f1f1',
                      color: msg.sender === 'user' ? 'white' : 'black',
                      padding: '10px',
                      borderRadius: '10px',
                      maxWidth: '70%',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {msg.isHtml ? <div dangerouslySetInnerHTML={{ __html: msg.text }} /> : msg.text}
                  </div>
                  {msg.sender === 'user' && <img src={userIcon} alt="user" style={{ width: '30px', marginLeft: '10px' }} />}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', marginTop: '10px' }}>
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Type your message..."
              style={{ flex: 1, padding: '10px', borderRadius: '5px', border: '1px solid #ddd' }}
              onKeyDown={(e) => e.key === 'Enter' && handleUserInput()}
            />
            <button
              onClick={handleUserInput}
              style={{
                marginLeft: '10px',
                padding: '10px',
                backgroundColor: '#ff4081',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default FieldMap;
