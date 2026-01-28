// src/services/natsService.js
import { connect, credsAuthenticator, StringCodec } from "nats.ws";

let nc = null;
const sc = StringCodec();

export function getNatsEnvConfig() {
  const url = process.env.REACT_APP_NATS_URL || "";
  const gpsSubject = process.env.REACT_APP_NATS_GPS_SUBJECT || "";
  const recordsPublishSubject = process.env.REACT_APP_NATS_RECORDS_PUB_SUBJECT || "";
  const credsRaw = process.env.REACT_APP_NATS_CREDS || "";

  return {
    url,
    gpsSubject,
    recordsPublishSubject,
    credsRaw
  };
}

// Turn REACT_APP_NATS_CREDS back into the original multi-line .creds text
function decodeCredsEnv(credsRaw) {
  const trimmed = (credsRaw || "").trim();
  if (!trimmed) return "";

  // If user pasted literal \n sequences in .env, convert them to actual newlines
  // (CRA will keep them as backslash-n in process.env)
  return trimmed.replace(/\\n/g, "\n");
}

export async function connectNats({ url, name } = {}) {
  const cfg = getNatsEnvConfig();
  const servers = url || cfg.url;

  if (!servers) {
    throw new Error("Missing REACT_APP_NATS_URL");
  }

  if (nc) return nc;

  const credsText = decodeCredsEnv(cfg.credsRaw);
  if (!credsText) {
    throw new Error("Missing REACT_APP_NATS_CREDS (operator-mode requires creds)");
  }

  nc = await connect({
    servers,
    name: name || "metaag-2o-ui",
    authenticator: credsAuthenticator(credsText)
  });

  return nc;
}

export async function disconnectNats() {
  if (!nc) return;
  try {
    await nc.drain();
  } finally {
    nc = null;
  }
}

// Subscribe and parse JSON messages
export async function subscribeJson({ subject, onMessage }) {
  const cfg = getNatsEnvConfig();
  const subSubject = subject || cfg.gpsSubject;
  if (!subSubject) throw new Error("Missing subject for subscribeJson (REACT_APP_NATS_GPS_SUBJECT)");

  if (!nc) {
    await connectNats();
  }

  const sub = nc.subscribe(subSubject);

  let cancelled = false;

  (async () => {
    for await (const m of sub) {
      if (cancelled) break;

      try {
        const txt = sc.decode(m.data);
        const json = JSON.parse(txt);
        onMessage?.(json, m.subject);
      } catch (e) {
        // ignore bad payloads
        // console.warn("Bad JSON from NATS:", e);
      }
    }
  })();

  // return unsubscribe
  return () => {
    cancelled = true;
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
  };
}

// Publish JSON payload
export async function publishJson({ subject, data }) {
  const cfg = getNatsEnvConfig();
  const pubSubject = subject || cfg.recordsPublishSubject;

  if (!pubSubject) {
    throw new Error("Missing subject for publishJson (REACT_APP_NATS_RECORDS_PUB_SUBJECT)");
  }

  if (!nc) {
    await connectNats();
  }

  const payload = JSON.stringify(data ?? {});
  nc.publish(pubSubject, sc.encode(payload));
}
