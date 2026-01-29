// src/services/natsService.js
import { connect, StringCodec } from "nats.ws";

let nc = null;
let subUnsubs = []; // track active subscriptions for cleanup
const sc = StringCodec();

export function getNatsEnvConfig() {
  return {
    url: process.env.REACT_APP_NATS_URL || "",
    gpsSubject: process.env.REACT_APP_NATS_GPS_SUBJECT || "",
    recordsPublishSubject: process.env.REACT_APP_NATS_RECORDS_PUB_SUBJECT || "",
    token: process.env.REACT_APP_NATS_TOKEN || "" // optional
  };
}

export function isNatsConnected() {
  return !!nc;
}

export async function connectNats({ url, name } = {}) {
  const cfg = getNatsEnvConfig();
  const servers = (url || cfg.url || "").trim();

  if (!servers) {
    throw new Error("Missing REACT_APP_NATS_URL (must be ws:// or wss:// endpoint)");
  }

  // Hard guard: people often put nats:// or the 4222 port
  if (servers.startsWith("nats://")) {
    throw new Error(`REACT_APP_NATS_URL must be ws:// or wss://, not nats:// (${servers})`);
  }

  if (nc) return nc;

  const opts = {
    servers,
    name: name || "metaag-2o-ui"
  };

  // Optional token auth
  if (cfg.token) opts.token = cfg.token;

  try {
    nc = await connect(opts);

    // Clear nc when it closes so reconnect works
    nc.closed()
      .then(() => {
        nc = null;
      })
      .catch(() => {
        nc = null;
      });

    return nc;
  } catch (e) {
    // Make the error more readable
    const msg = e?.message || String(e);
    throw new Error(`NATS WS connect failed to ${servers}: ${msg}`);
  }
}

export async function disconnectNats() {
  // unsubscribe local subs
  for (const u of subUnsubs) {
    try {
      u();
    } catch {
      // ignore
    }
  }
  subUnsubs = [];

  if (!nc) return;
  try {
    await nc.drain();
  } finally {
    nc = null;
  }
}

/**
 * Subscribe to a subject and parse JSON messages.
 * Returns an unsubscribe function.
 */
export async function subscribeJson({ subject, onMessage }) {
  const cfg = getNatsEnvConfig();
  const subSubject = (subject || cfg.gpsSubject || "").trim();
  if (!subSubject) throw new Error("Missing subscribe subject (REACT_APP_NATS_GPS_SUBJECT)");

  if (!nc) await connectNats();

  const sub = nc.subscribe(subSubject);
  let cancelled = false;

  (async () => {
    try {
      for await (const m of sub) {
        if (cancelled) break;

        const txt = sc.decode(m.data);
        try {
          const json = JSON.parse(txt);
          onMessage?.(json, m.subject);
        } catch {
          // if not JSON, pass raw for debugging
          onMessage?.({ _raw: txt }, m.subject);
        }
      }
    } catch (e) {
      // subscription loop errors (disconnects etc.)
      console.error("NATS subscribe loop error:", e);
    }
  })();

  const unsubscribe = () => {
    cancelled = true;
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
  };

  subUnsubs.push(unsubscribe);
  return unsubscribe;
}

/**
 * Publish a JSON payload to a subject.
 */
export async function publishJson({ subject, data }) {
  const cfg = getNatsEnvConfig();
  const pubSubject = (subject || cfg.recordsPublishSubject || "").trim();
  if (!pubSubject) throw new Error("Missing publish subject (REACT_APP_NATS_RECORDS_PUB_SUBJECT)");

  if (!nc) await connectNats();

  try {
    nc.publish(pubSubject, sc.encode(JSON.stringify(data ?? {})));
  } catch (e) {
    const msg = e?.message || String(e);
    throw new Error(`NATS publish failed (${pubSubject}): ${msg}`);
  }
}
