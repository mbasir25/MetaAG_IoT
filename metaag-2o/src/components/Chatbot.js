import React, { useState, useEffect, useRef  } from "react";
import { getUnsentVisits, removeVisit } from "../storage";
import { getAirtableFields } from "../airtableSchema";
import Fuse from "fuse.js";

const formatDate = (isoString) => {
  const date = new Date(isoString);
  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
};

const generateNaturalQuestion = async (fieldName) => {
  const prompt = `Create a short, friendly question a field worker might be asked to collect information about "${fieldName}". Make it natural and clear.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 50,
      temperature: 0.7,
    }),
  });





  const data = await res.json();
  return data.choices?.[0]?.message?.content || `What is the ${fieldName}?`;
};

const findBestMatch = (keywords, fields) => {
  const lowerFields = fields.map(f => f.toLowerCase());
  for (let keyword of keywords) {
    const index = lowerFields.findIndex(f => f.includes(keyword.toLowerCase()));
    if (index !== -1) return fields[index];
  }
  return null;
};


const correctSpelling = async (text) => {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages: [
          {
            role: "user",
            content: `Correct the spelling (if needed) in this text without changing the meaning: "${text}". Return only the corrected version.`,
          },
        ],
        max_tokens: 50,
        temperature: 0.2,
      }),
    });

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch (err) {
    console.error("Spelling correction failed:", err);
    return text; // fallback
  }
};

const fetchReferenceOptions = async (tableName) => {
  try {
    const res = await fetch(`https://api.airtable.com/v0/${process.env.REACT_APP_AIRTABLE_BASE_ID}/${tableName}`, {
      headers: {
        Authorization: `Bearer ${process.env.REACT_APP_AIRTABLE_API_KEY}`,
      },
    });
    const data = await res.json();
    return data.records
      .map(r => r.fields?.Name || r.fields?.Title || "")
      .filter(Boolean);
  } catch (err) {
    console.error("Failed to fetch reference options:", err);
    return [];
  }
};

const fuzzyTableMatch = (fieldName, tableNames) => {
  const normalize = (str) => str.replace(/[_\-]/g, " ").toLowerCase().trim();

  const processedField = normalize(fieldName);
  const processedTables = tableNames.map(name => ({ raw: name, norm: normalize(name) }));

  const fuse = new Fuse(processedTables, {
    keys: ['norm'],
    includeScore: true,
    threshold: 0.7, // more forgiving

  });

  const result = fuse.search(processedField);
  return result.length > 0 ? result[0].item.raw : null;
};

const fuzzyValueMatch = (userInput, options) => {
  const fuse = new Fuse(options, {
    includeScore: true,
    threshold: 0.4,
  });
  const result = fuse.search(userInput);
  return result.length > 0 ? result[0].item : null;
};



const validateUserInputWithReference = async (fieldName, userInput, allTableNames) => {
  console.log("🔎 Validating input for field:", fieldName);
  console.log("📚 Tables available:", allTableNames);

  const tableMatchPrompt = `
You are helping to find the most relevant reference table from Airtable.

The field name is: "${fieldName}"  
Available table names: [${allTableNames.join(", ")}]

Which table is the most SEMANTICALLY related to the field? Think of synonyms and related concepts. 
Return ONLY the name of the best match. If nothing is even loosely related, return "none".
`;

  let matchedTable = null;

  try {
    const matchRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages: [{ role: "user", content: tableMatchPrompt }],
        max_tokens: 20,
        temperature: 0.2,
      }),
    });

    const matchData = await matchRes.json();
    matchedTable = matchData.choices?.[0]?.message?.content?.trim();
    console.log("🤖 GPT matched table:", matchedTable);

    // Fallback to fuzzy matching if GPT fails or says "none"
    if (!matchedTable || matchedTable.toLowerCase() === "none") {
      matchedTable = fuzzyTableMatch(fieldName, allTableNames);
      console.log("🔁 Fuzzy fallback matched table:", matchedTable);
    }
  } catch (err) {
    console.warn("⚠️ GPT table match failed:", err);
  }

  // Fuzzy fallback
  if (!matchedTable || matchedTable.toLowerCase() === "none") {
    matchedTable = fuzzyTableMatch(fieldName, allTableNames);
    console.log("🔁 Fuzzy fallback matched table:", matchedTable);
  }

  // Final fallback to spell checking
  if (!matchedTable) {
    console.log("❌ No match found — using spell check fallback.");
    const corrected = await correctSpelling(userInput);
    return { value: corrected, type: "spell" };
  }

  // Fetch reference options from matched table
  const options = await fetchReferenceOptions(matchedTable);
  console.log("📌 Reference options from table:", matchedTable, options);

  if (!options.length) {
  console.log("⚠️ Reference table has no values — skipping validation");
  return { value: userInput, type: "original" };
}


  // Validate input against options
  const validatePrompt = `These are valid values: [${options.join(", ")}]. The user said "${userInput}". What is the closest correct value, if any? If none match semantically, return "none". Otherwise, return the best match.`;

  try {
    const valRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages: [{ role: "user", content: validatePrompt }],
        max_tokens: 30,
        temperature: 0.3,
      }),
    });

    const valData = await valRes.json();
    const validated = valData.choices?.[0]?.message?.content?.trim();
    console.log("✅ AI validated value:", validated);

    if (!validated || validated.toLowerCase() === "none") {
  console.log("🤖 GPT could not match input to options — trying fuzzy fallback");

  // First, check for prefix-based partial matches (e.g., "Nitr" → "Nitrate-234xxx")
  const partialMatch = options.find(opt =>
    opt.toLowerCase().startsWith(userInput.toLowerCase())
  );
  if (partialMatch) {
    console.log("🔁 Found partial match:", partialMatch);
    return {
      value: partialMatch,
      original: userInput,
      type: "validated"
    };
  }

  // Then try fuzzy matching
  const fuzzyMatch = fuzzyValueMatch(userInput, options);
  if (fuzzyMatch) {
    console.log("🔁 Fuzzy value match result:", fuzzyMatch);
    return {
      value: fuzzyMatch,
      original: userInput,
      type: "validated"
    };
  }

  // Nothing matched — fallback
  console.log("❌ No match found — falling back to original input");
  return { value: userInput, type: "original" };
}



    return {
      value: validated,
      original: userInput,
      type: validated === userInput ? "original" : "validated",
    };
  } catch (err) {
    console.error("❌ GPT validation failed:", err);
    const corrected = await correctSpelling(userInput);
    return { value: corrected, type: "spell" };
  }
};




const Chatbot = ({ apiKey }) => {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [fieldQueue, setFieldQueue] = useState([]);
  const [answers, setAnswers] = useState({});
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(null);
  const [fieldMap, setFieldMap] = useState({});
  const bottomRef = useRef(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const latestVisit = getUnsentVisits().slice(-1)[0];

  const startChat = async () => {
    if (!latestVisit) {
      setMessages([{ from: "bot", text: "No recent visits found." }]);
      return;
    }

    const { polygon, entryTime, exitTime } = latestVisit;
    const durationMinutes = Math.round((new Date(exitTime) - new Date(entryTime)) / 60000);

    try {
      const fieldNames = await getAirtableFields(
        process.env.REACT_APP_AIRTABLE_API_KEY,
        process.env.REACT_APP_AIRTABLE_BASE_ID,
        process.env.REACT_APP_AIRTABLE_TABLE
      );

      const polygonField = findBestMatch(["field", "polygon", "location"], fieldNames);
      const entryField = findBestMatch(["entry", "start"], fieldNames);
      const exitField = findBestMatch(["exit", "end"], fieldNames);
      const durationField = findBestMatch(["duration"], fieldNames);
      setFieldMap({ polygonField, entryField, exitField, durationField });

      const filteredFields = fieldNames.filter((f) => {
        const lower = f.toLowerCase();
        return !(
          lower.includes("entry") ||
          lower.includes("exit") ||
          lower.includes("duration") ||
          lower.includes("latitude") ||
          lower.includes("longitude") ||
          lower.includes("polygon") ||
          lower.includes("field") ||
          lower.includes("synced")
        );
      });

      setFieldQueue(filteredFields);

      const intro = `Hi! You worked at ${polygon} from ${formatDate(entryTime)} to ${formatDate(exitTime)} (${durationMinutes} minutes). Let's record the rest of the activity.`;
      const question = await generateNaturalQuestion(filteredFields[0]);
      setMessages([
        { from: "bot", text: intro },
        { from: "bot", text: question }
      ]);
    } catch (err) {
      setMessages([{ from: "bot", text: "Error connecting to Airtable." }]);
    }
  };

  const handleSubmit = async () => {
    if (!input.trim()) return;
    const userInput = input.trim();
    setMessages(prev => [...prev, { from: "user", text: userInput }]);
    setInput("");

    if (awaitingConfirmation) {
      const lower = userInput.toLowerCase();
      if (lower === "yes" || lower === "as-is") {
        const { field, value, original, type } = awaitingConfirmation;
        const confirmedValue = lower === "as-is" ? original : value;

        setAnswers((prev) => ({ ...prev, [field]: confirmedValue }));

        const remaining = fieldQueue.slice(1);
        setFieldQueue(remaining);
        setAwaitingConfirmation(null);

        if (remaining.length === 0) {
          const summary = Object.entries({ ...answers, [field]: confirmedValue })
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n");
          setMessages(prev => [...prev, { from: "bot", text: `Here's what you recorded:\n${summary}\nType 'yes' to confirm and submit.` }]);
        } else {
          const nextQ = await generateNaturalQuestion(remaining[0]);
          setMessages(prev => [...prev, { from: "bot", text: nextQ }]);
        }

        return;
      }
      else {
        setMessages(prev => [...prev, { from: "bot", text: `Okay, please re-enter the value for ${awaitingConfirmation.field}.` }]);
        setAwaitingConfirmation(null);
      }
      return;
    }

    if (userInput.toLowerCase() === "yes" && fieldQueue.length === 0) {
      try {
        const record = {
          fields: {
            ...answers,
            [fieldMap.polygonField || "Polygon"]: latestVisit.polygon,
            [fieldMap.entryField || "Entry"]: formatDate(latestVisit.entryTime),
            [fieldMap.exitField || "Exit"]: formatDate(latestVisit.exitTime),
            [fieldMap.durationField || "Duration"]: `${Math.round((new Date(latestVisit.exitTime) - new Date(latestVisit.entryTime)) / 60000)} minutes`
          }
        };

        const res = await fetch(
          `https://api.airtable.com/v0/${process.env.REACT_APP_AIRTABLE_BASE_ID}/${process.env.REACT_APP_AIRTABLE_TABLE}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.REACT_APP_AIRTABLE_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(record)
          }
        );
        const data = await res.json();
        if (data.id) {
          removeVisit(latestVisit);
          setMessages(prev => [...prev, { from: "bot", text: "✅ Data saved to Airtable successfully!" }]);
        } else {
          setMessages(prev => [...prev, { from: "bot", text: `❌ Error saving data: ${data.error?.message || "Unknown error"}` }]);
        }
      } catch (err) {
        setMessages(prev => [...prev, { from: "bot", text: "❌ Failed to save." }]);
      }
      return;
    }

    const currentField = fieldQueue[0];
      const allTableNames = await getAirtableFields(
        process.env.REACT_APP_AIRTABLE_API_KEY,
        process.env.REACT_APP_AIRTABLE_BASE_ID,
        "" // not specifying table returns schema from all
      );

      const validation = await validateUserInputWithReference(currentField, userInput, allTableNames);

      setAwaitingConfirmation({ field: currentField, value: validation.value, original: validation.original || userInput, type: validation.type });

      let confirmationMessage;
      if (validation.type === "validated") {
        confirmationMessage = `You said: "${validation.original}". I suggest: "${validation.value}". Type 'yes' to accept, 'no' to retype, or 'as-is' to save your original input.`;
      } else if (validation.type === "spell") {
        confirmationMessage = validation.value === userInput
          ? `You said: "${userInput}". Type 'yes' to confirm or 'no' to retype.`
          : `Did you mean: "${validation.value}"? Type 'yes' to accept or 'no' to retype.`;
      } else {
        confirmationMessage = `You said: "${userInput}". Type 'yes' to confirm or 'no' to retype.`;
      }

      setMessages(prev => [...prev, { from: "bot", text: confirmationMessage }]);


  };

  const toggleChat = () => {
    setOpen(!open);
    if (!open && messages.length === 0) startChat();
  };

  return (
    <>
      <div onClick={toggleChat} style={{ position: "fixed", bottom: 20, right: 20, width: 60, height: 60, background: "#007bff", borderRadius: "50%", display: "flex", justifyContent: "center", alignItems: "center", color: "white", fontSize: 30, cursor: "pointer", zIndex: 999 }}>
        🤖
      </div>
      {open && (
        <div style={{ position: "fixed", bottom: 90, right: 20, width: 300, maxHeight: 400, height: "auto", overflow: "hidden", background: "white", border: "1px solid #ccc", borderRadius: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.2)", zIndex: 998, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, padding: "1rem", overflowY: "auto", fontSize: "0.875rem" }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ marginBottom: "0.75rem", textAlign: msg.from === "bot" ? "left" : "right" }}>
                <div style={{ background: msg.from === "bot" ? "#f0f0f0" : "#d1e7ff", padding: "0.5rem 0.75rem", borderRadius: "8px", display: "inline-block" }}>{msg.text}</div>
              </div>
            ))}
            {loading && <p>Typing...</p>}
            <div ref={bottomRef} />
          </div>
          <div style={{ padding: "0.5rem", borderTop: "1px solid #ddd" }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Type your answer..."
              style={{ width: "80%", padding: "0.4rem", borderRadius: "6px", border: "1px solid #ccc" }}
            />
            <button
              onClick={handleSubmit}
              style={{ marginLeft: "0.5rem", padding: "0.4rem 0.6rem", borderRadius: "6px", border: "none", background: "#007bff", color: "white", cursor: "pointer" }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default Chatbot;
