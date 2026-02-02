# -*- coding: utf-8 -*-
"""
Created on Mon Feb  2 12:42:18 2026

@author: samif
"""

import asyncio
import json
import os
import random
from datetime import datetime, timezone

from nats.aio.client import Client as NATS


def iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_message(machine_id: str, name: str, lat: float, lng: float, seq: int) -> dict:
    # Always-changing timestamp + seq help your UI update even if lat/lng barely change.
    return {
        "machineId": machine_id,
        "deviceId": "dfgrsbdtfgd",      # handy if your UI keys on deviceId
        "name": "combine123",
        "lat": lat,
        "lng": lng,
        "timestamp": iso_utc_now(),  # live timestamp
        "seq": seq,
    }


async def main():
    # NATS connection (TCP)
    nats_url = os.getenv("NATS_URL", "nats://127.0.0.1:4222")

    # IMPORTANT: set this to your app’s REACT_APP_NATS_GPS_SUBJECT value
    subject = os.getenv("NATS_SUBJECT", "machine.gps.machine-001")

    # Machine identity
    machine_id = os.getenv("MACHINE_ID", "machine-001")
    name = os.getenv("MACHINE_NAME", "Tractor_Tafe101")

    # Starting location (near Indianapolis by default)
    lat = float(os.getenv("START_LAT", "40.4219126427358"))
    lng = float(os.getenv("START_LNG", "-86.9166588639234"))


    # Rate: 2 messages/sec
    rate_hz = float(os.getenv("RATE_HZ", "1"))
    period = 1.0 / rate_hz

    # If you want tiny movement each message, set JITTER_METERS (e.g. 0.5)
    jitter_m = float(os.getenv("JITTER_METERS", "0.0"))

    # Very rough meters->degrees conversion for small jitters
    # 1 deg lat ~ 111,111m ; 1 deg lng depends on latitude
    def jitter_degrees(lat_deg: float, meters: float):
        if meters <= 0:
            return 0.0, 0.0
        dlat = (random.uniform(-meters, meters) / 111_111.0)
        dlng = (random.uniform(-meters, meters) / (111_111.0 * max(0.2, abs(__import__("math").cos(__import__("math").radians(lat_deg))))))
        return dlat, dlng

    nc = NATS()
    await nc.connect(servers=[nats_url])
    print(f" Connected to NATS: {nats_url}")
    print(f" Publishing to subject: {subject}")
    print(f" Machine: {machine_id} ({name}) @ {lat},{lng} | {rate_hz} msg/sec")

    seq = 0
    try:
        while True:
            seq += 1

            dlat, dlng = jitter_degrees(lat, jitter_m)
            msg = build_message(machine_id, name, lat + dlat, lng + dlng, seq)

            payload = json.dumps(msg).encode("utf-8")
            await nc.publish(subject, payload)

            # Flush occasionally to ensure the broker gets it quickly
            if seq % 10 == 0:
                await nc.flush()

            print(f"→ {seq} {msg['timestamp']} lat={msg['lat']:.6f} lng={msg['lng']:.6f}")
            await asyncio.sleep(period)

    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        await nc.drain()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
