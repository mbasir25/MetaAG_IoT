// src/services/natsService.js
// NATS (WebSocket) client helpers for the browser.
//
// Install:
//   npm i nats.ws
//
// CRA env vars:
//   REACT_APP_NATS_URL
//   REACT_APP_NATS_TOKEN
//   REACT_APP_NATS_GPS_SUBJECT
//   REACT_APP_NATS_RECORDS_PUB_SUBJECT

import { connect, StringCodec } from "nats.ws";

const sc = StringCodec();

let nc = null;
let activeSubAbort = null;

export const getNatsConnection = () => nc;

export const getNatsEnvConfig = () => {
  return {
    url: process.env.REACT_APP_NATS_URL,
    token: process.env.REACT_APP_NATS_TOKEN,
    gpsSubject: process.env.REACT_APP_NATS_GPS_SUBJECT,
    recordsPublishSubject: process.env.REACT_APP_NATS_RECORDS_PUB_SUBJECT
  };
};

export const connectNats = async ({ url, token, name = "metaag-2o-ui" } = {}) => {
  if (nc) return nc;
  if (!url) throw new Error("REACT_APP_NATS_URL is missing");

  nc = await connect({
    servers: url,
    token: token || undefined,
    name,
    reconnect: true,
    maxReconnectAttempts: -1
  });

  return nc;
};

export const disconnectNats = async () => {
  try {
    if (activeSubAbort) {
      activeSubAbort.abort();
      activeSubAbort = null;
    }
  } catch {
    // ignore
  }

  try {
    if (nc) {
      await nc.drain();
      await nc.close();
    }
  } catch {
    // ignore
  } finally {
    nc = null;
  }
};

/**
 * Subscribe to a subject and decode JSON payloads.
 * Returns: unsubscribe function.
 */
export const subscribeJson = async ({ subject, onMessage }) => {
  if (!nc) throw new Error("NATS is not connected");
  if (!subject) throw new Error("GPS subject is required");

  // Ensure we don't run multiple simultaneous subscriptions.
  if (activeSubAbort) {
    activeSubAbort.abort();
    activeSubAbort = null;
  }

  const abort = new AbortController();
  activeSubAbort = abort;

  const sub = nc.subscribe(subject);

  (async () => {
    try {
      for await (const m of sub) {
        if (abort.signal.aborted) break;

        let text = "";
        try {
          text = sc.decode(m.data);
        } catch {
          continue;
        }
        if (!text) continue;

        let obj;
        try {
          obj = JSON.parse(text);
        } catch (e) {
          console.warn("NATS: ignoring non-JSON message:", text);
          continue;
        }

        try {
          onMessage?.(obj);
        } catch (e) {
          console.error("NATS: onMessage handler error:", e);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        console.error("NATS subscription ended unexpectedly:", e);
      }
    }
  })();

  return () => {
    try {
      abort.abort();
      sub.unsubscribe();
    } catch {
      // ignore
    }
  };
};

export const publishJson = async ({ subject, data }) => {
  if (!nc) throw new Error("NATS is not connected");
  if (!subject) throw new Error("Publish subject is required");
  const payload = sc.encode(JSON.stringify(data));
  nc.publish(subject, payload);
};
