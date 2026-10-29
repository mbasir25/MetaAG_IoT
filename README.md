# MetaAg IoT

**GPS- and Event-Driven Context Capture for Agricultural Recordkeeping**

MetaAg IoT is a research prototype that connects machine-location events with MetaAg 2.0's AI-assisted farm-operation recordkeeping workflow. It uses browser/device GPS, machine GPS messages received through NATS, and mapped field boundaries to identify field visits and provide context for operation records.

## What it does

- Subscribes to machine GPS messages through a NATS publish–subscribe connection.
- Uses field polygons and GPS positions to detect field entry and exit, and to associate visits with a location and time interval.
- Identifies nearby machines from recent GPS messages and asks the operator to confirm the machine association.
- Provides a MetaAg 2.0 conversational interface for collecting and checking additional operation details.
- Prepares GPS-derived field-visit records and lets the user publish them as JSON messages to a configured NATS subject.

## Workflow

1. Receive machine-position events and monitor the operator's device location.
2. Match positions to field boundaries; identify candidate nearby machines for operator confirmation.
3. Record a field visit with field, person, machine (when paired), and entry/exit times.
4. Use the chatbot to collect missing operation information.
5. Publish pending field-visit records through the interface's **Send Records** action.

## Run locally

The application is a React project in `metaag-2o/`.

```bash
cd metaag-2o
npm install
npm start
```

Configure the relevant environment variables before starting, including `REACT_APP_GOOGLE_MAPS_API_KEY`, `REACT_APP_NATS_URL` (a `ws://` or `wss://` endpoint), and `REACT_APP_NATS_RECORDS_PUB_SUBJECT`. The AI/chatbot and database features require their own service configuration. Device geolocation needs browser permission. A machine-GPS publishing example is available in `metaag-2o/nats_scripts/`.

## Current scope

This is research software, not an autonomous farm-management system. The repository snapshot publishes **GPS-derived visit records** through the Send Records action. The chatbot's finalized-operation callback is present, but its connection to NATS publication is not completed in this snapshot; it currently logs the finalized payload. Machine identification is confirmed by the operator rather than inferred solely from proximity.

MetaAg IoT uses the existing Avena/NATS event environment; it does not implement the underlying Avena framework.
