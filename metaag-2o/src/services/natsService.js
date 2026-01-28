// src/services/natsService.js
import { connect, StringCodec } from "nats.ws";

let nc = null;
const sc = StringCodec();

export function getNatsEnvConfig() {
  const url = process.env.REACT_APP_NATS_URL || "";
  const gpsSubject = process.env.REACT_APP_NATS_GPS_SUBJECT || "";
  const recordsPublishSubject = process.env.REACT_APP_NATS_RECORDS_PUB_SUBJECT || "";

  // Optional token support if you later add it:
  const token = process.env.REACT_APP_NATS_TOKEN || "";

  return { url, gpsSubject, recordsPublishSubject, token };
}

export async function connectNats({ url, name } = {}) {
  const cfg = getNatsEnvConfig();
  const servers = url || cfg.url;

  if (!servers) {
    throw new Error("Missing REACT_APP_NATS_URL (must be ws:// or wss:// endpoint)");
  }

  if (nc) return nc;

  const opts = {
    servers,
    name: name || "metaag-2o-ui"
  };

  // If you later decide to use simple token auth:
  if (cfg.token) {
    opts.token = cfg.token;
  }

  nc = await connect(opts);

  // Clear nc on close so reconnect works
  nc.closed()
    .then(() => {
      nc = null;
    })
    .catch(() => {
      nc = null;
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

export async function subscribeJson({ subject, onMessage }) {
  const cfg = getNatsEnvConfig();
  const subSubject = subject || cfg.gpsSubject;

  if (!subSubject) {
    throw new Error("Missing subscribe subject (REACT_APP_NATS_GPS_SUBJECT)");
  }

  if (!nc) {
    await connectNats();
  }

  const sub = nc.subscribe(subSubject);
  let cancelled = false;

  (async () => {
    for await (const m of sub) {
      if (cancelled) break;

      const txt = sc.decode(m.data);
      try {
        const json = JSON.parse(txt);
        onMessage?.(json, m.subject);
      } catch {
        // If message isn't JSON, still pass something useful for debugging:
        onMessage?.({ _raw: txt }, m.subject);
      }
    }
  })();

  return () => {
    cancelled = true;
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
  };
}

export async function publishJson({ subject, data }) {
  const cfg = getNatsEnvConfig();
  const pubSubject = subject || cfg.recordsPublishSubject;

  if (!pubSubject) {
    throw new Error("Missing publish subject (REACT_APP_NATS_RECORDS_PUB_SUBJECT)");
  }

  if (!nc) {
    await connectNats();
  }

  nc.publish(pubSubject, sc.encode(JSON.stringify(data ?? {})));
}
