export async function logVisitToAirtable({ polygon, entryTime, exitTime, position }) {
  const key = process.env.REACT_APP_AIRTABLE_API_KEY;
  const baseId = process.env.REACT_APP_AIRTABLE_BASE_ID;
  const table = process.env.REACT_APP_AIRTABLE_TABLE;

  const url = `https://api.airtable.com/v0/${baseId}/${table}`;

  const record = {
    fields: {
      "Polygon Name": polygon || "Unknown",
      "Entry Time": entryTime,
      "Exit Time": exitTime || "",
      "Latitude": position.lat,
      "Longitude": position.lng
    }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(record)
    });

    if (!res.ok) {
      console.error("Airtable error:", await res.text());
    } else {
      console.log("✅ Visit logged to Airtable");
    }
  } catch (err) {
    console.error("Airtable connection failed:", err);
  }
}
