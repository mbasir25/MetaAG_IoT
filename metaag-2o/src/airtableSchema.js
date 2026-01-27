export async function getAirtableFields(apiKey, baseId, tableName) {
  const url = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const data = await res.json();
  const table = data.tables.find(t => t.name === tableName);
  if (!table) return [];

  return table.fields.map(f => f.name);
}
