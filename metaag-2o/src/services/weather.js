// src/services/weather.js

const API_KEY = process.env.REACT_APP_WEATHERSTACK_KEY;
if (!API_KEY) {
  console.warn("WARNING: WEATHERSTACK API key not set (REACT_APP_WEATHERSTACK_KEY)");
}

const BASE_URL = "https://api.weatherstack.com";

// Helpers
const toISO = (d) => new Date(d).toISOString().slice(0, 10);

// Map Weatherstack response to our simplified daily object
function mapDailyWeather(wsData) {
  const out = {};
  if (!wsData) return out;

  // Historical endpoint returns { historical: { "2025-08-29": { ... } } }
  if (wsData.historical) {
    for (const dateKey of Object.keys(wsData.historical)) {
      const day = wsData.historical[dateKey];
      out[dateKey] = {
        tmax: day.maxtemp ?? null,
        tmin: day.mintemp ?? null,
        precip: day.totalprecip ?? null,
        windmax: day.maxwind ?? null,
      };
    }
  }
  // Forecast endpoint returns { forecast: { "2025-09-01": { ... } } }
  else if (wsData.forecast) {
    for (const dateKey of Object.keys(wsData.forecast)) {
      const day = wsData.forecast[dateKey];
      out[dateKey] = {
        tmax: day.maxtemp ?? null,
        tmin: day.mintemp ?? null,
        precip: day.totalprecip ?? null,
        windmax: day.maxwind ?? null,
      };
    }
  }
  // Current endpoint returns only current; we map it to today’s date
  else if (wsData.current && wsData.location) {
    const today = toISO(new Date());
    out[today] = {
      tmax: wsData.current.temperature,
      tmin: wsData.current.temperature,
      precip: wsData.current.precip,
      windmax: wsData.current.wind_speed,
    };
  }

  return out;
}

// Historical data
export async function fetchHistorical(lat, lng, startDate, endDate) {
  const start = toISO(startDate);
  const end   = toISO(endDate);
  const url = `${BASE_URL}/historical?access_key=${API_KEY}&query=${lat},${lng}&historical_date_start=${start}&historical_date_end=${end}&units=m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weatherstack historical API failed (${res.status})`);
  const data = await res.json();
  return data;
}

// Forecast data
export async function fetchForecast(lat, lng, days = 7) {
  const url = `${BASE_URL}/forecast?access_key=${API_KEY}&query=${lat},${lng}&forecast_days=${days}&units=m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weatherstack forecast API failed (${res.status})`);
  const data = await res.json();
  return data;
}

// Current data
export async function fetchCurrent(lat, lng) {
  const url = `${BASE_URL}/current?access_key=${API_KEY}&query=${lat},${lng}&units=m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weatherstack current API failed (${res.status})`);
  const data = await res.json();
  return data;
}

// Unified wrapper
export async function fetchWeatherByDateRange(lat, lng, startDate, endDate) {
  const todayISO = toISO(new Date());
  let mode = null;
  let raw = null;
  let dailyByDate = {};

  // If endDate is after today → forecast
  if (endDate > todayISO) {
    mode = 'forecast';
    raw = await fetchForecast(lat, lng);
    dailyByDate = mapDailyWeather(raw);
  } else {
    mode = 'historical';
    raw = await fetchHistorical(lat, lng, startDate, endDate);
    dailyByDate = mapDailyWeather(raw);

    // If no data found, fallback to current or forecast
    if (Object.keys(dailyByDate).length === 0) {
      console.warn('⚠️ No historical data found, trying current as fallback');
      raw = await fetchCurrent(lat, lng);
      dailyByDate = mapDailyWeather(raw);
      mode = 'current-fallback';
    }
  }

  return { mode, raw, dailyByDate };
}
