// src/EnterpriseChatbot.js
import React, { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { ref, get, child, set } from "firebase/database";
import { getUnsentVisits } from "../storage";

const SKIPPED_FIELDS = ["Entry", "Exit", "Fieldname"];

const EnterpriseChatbot = () => {
  const [messages, setMessages] = useState([]);
  const [userInput, setUserInput] = useState("");
  const [currentField, setCurrentField] = useState(null);
  const [fieldOrder, setFieldOrder] = useState([]);
  const [responses, setResponses] = useState({});
  const [autoFields, setAutoFields] = useState({});
  const [dbTables, setDbTables] = useState({});
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [correctedMatch, setCorrectedMatch] = useState(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handler = () => window.location.hash = "#map";
    window.addEventListener("visualize-fields", handler);
    return () => window.removeEventListener("visualize-fields", handler);
    }, []);

  useEffect(() => {
    const loadSchemaAndVisits = async () => {
      const [schemaSnap, localVisits, fullDbSnap] = await Promise.all([
        get(child(ref(db), "Operations/template")),
        getUnsentVisits(),
        get(ref(db))
      ]);

      if (!schemaSnap.exists()) return;
      const template = schemaSnap.val();
      const keys = Object.keys(template);
      const visit = localVisits?.[localVisits.length - 1];
      const fullDb = fullDbSnap.exists() ? fullDbSnap.val() : {};
      setDbTables(fullDb);

      const autoPrefill = visit ? {
        Entry: visit.entryTime || "",
        Exit: visit.exitTime || "",
        Fieldname: visit.polygon || ""
      } : {};

      if (keys.some(k => k.toLowerCase().includes("duration")) && visit?.entryTime && visit?.exitTime) {
        const durationMs = new Date(visit.exitTime) - new Date(visit.entryTime);
        const durationMin = Math.round(durationMs / 60000);
        autoPrefill["Duration"] = `${durationMin} minutes`;
      }

      const ordered = keys.filter(key => !SKIPPED_FIELDS.includes(key)).concat(SKIPPED_FIELDS);

      setFieldOrder(ordered);
      setResponses(autoPrefill);
      setAutoFields(autoPrefill);

      const firstManualField = ordered.find(key => !autoPrefill[key]);
      setCurrentField(firstManualField);

      const greeting = visit
        ? `Hey there! I noticed you were at the '${visit.polygon}' field around ${new Date(visit.entryTime).toLocaleTimeString()}. Mind if we quickly log what happened?`
        : `Hey there! Ready to log what you just did in the field?`;

      setMessages([{ sender: "bot", text: greeting }]);

      for (const key of ordered) {
        if (autoPrefill[key]) {
          setMessages(prev => [...prev, { sender: "bot", text: `No need to ask — I've already got "${key}" as '${autoPrefill[key]}' 😉` }]);
        } else {
          setMessages(prev => [...prev, { sender: "bot", text: generateQuestion(key) }]);
          break;
        }
      }
    };

    loadSchemaAndVisits();
  }, []);

  const generateQuestion = (fieldName) => {
    return `Alright, could you fill me in on "${fieldName}"?`;
  };

  const findMatchingTable = (field) => {
  const fieldLc = field.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const table of Object.keys(dbTables)) {
    const tableLc = table.toLowerCase();
    let score = 0;

    if (fieldLc === tableLc) score = 100;
    else if (fieldLc.includes(tableLc) || tableLc.includes(fieldLc)) score = 80;
    else {
      const shared = fieldLc.split('').filter(c => tableLc.includes(c)).length;
      score = (shared / fieldLc.length) * 50;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = table;
    }
  }

  return bestScore >= 40 ? bestMatch : null;
};

  const extractKnownValues = (table) => {
    return Object.values(table).map(item => {
      if (typeof item === "string") return item;
      if (typeof item === "object") return Object.values(item).join(" ");
      return null;
    }).filter(Boolean);
  };

  const semanticMatch = async (field, userValue) => {
    const tableName = findMatchingTable(field);
    if (!tableName || typeof dbTables[tableName] !== "object") return { match: false, corrected: userValue };

    const knownValues = extractKnownValues(dbTables[tableName]);
    if (!knownValues.length) return { match: false, corrected: userValue };

    const prompt = `You are helping validate data entry in a farm log app. The user typed: "${userValue}" for field "${field}".

Here is the list of valid known values:
${knownValues.map((val, i) => `${i + 1}. ${val}`).join("\n")}

Suggest the closest match based on spelling or semantic similarity. Respond ONLY with the best match from the list. If none are even remotely correct, respond exactly with: NO_MATCH.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3
      })
    });

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (reply === "NO_MATCH") return { match: false, corrected: userValue };
    return { match: true, corrected: reply };
  };

  const handleUserInput = async () => {
    if (!userInput.trim()) return;

    if (awaitingConfirmation && correctedMatch !== null) {
      if (userInput.toLowerCase() === "yes") {
        const updatedResponses = { ...responses, [currentField]: correctedMatch };
        setResponses(updatedResponses);
        setMessages(prev => [...prev, { sender: "bot", text: `Got it. Saved "${correctedMatch}".` }]);
        setUserInput("");
        setAwaitingConfirmation(false);
        setCorrectedMatch(null);
        proceedToNextField(updatedResponses);
        return;
      } else {
        setMessages(prev => [...prev, { sender: "bot", text: `Okay, let's try again. What should we log for "${currentField}"?` }]);
        setUserInput("");
        setAwaitingConfirmation(false);
        setCorrectedMatch(null);
        return;
      }
    }

    const matchResult = await semanticMatch(currentField, userInput.trim());

    if (!matchResult.match) {
      setCorrectedMatch(userInput.trim());
      setUserInput("");
      setAwaitingConfirmation(true);
      setMessages(prev => [...prev, { sender: "user", text: userInput.trim() }, { sender: "bot", text: `I couldn't confidently match "${userInput.trim()}" for "${currentField}". Want to save it as-is? (yes/no)` }]);
      return;
    }

    if (matchResult.corrected.toLowerCase() !== userInput.trim().toLowerCase()) {
      setCorrectedMatch(matchResult.corrected);
      setUserInput("");
      setAwaitingConfirmation(true);
      setMessages(prev => [...prev, { sender: "user", text: userInput.trim() }, { sender: "bot", text: `Did you mean "${matchResult.corrected}" for "${currentField}"? (yes/no)` }]);
      return;
    }

    const updatedResponses = { ...responses, [currentField]: matchResult.corrected };
    setResponses(updatedResponses);
    setMessages(prev => [...prev, { sender: "user", text: userInput.trim() }]);
    setUserInput("");
    proceedToNextField(updatedResponses);
  };

  const proceedToNextField = (updatedResponses) => {
    let nextIndex = fieldOrder.indexOf(currentField) + 1;
    while (nextIndex < fieldOrder.length) {
      const nextField = fieldOrder[nextIndex];
      if (autoFields[nextField]) {
        setResponses(prev => ({ ...prev, [nextField]: autoFields[nextField] }));
        setMessages(prev => [...prev, { sender: "bot", text: `No worries, "${nextField}" is already set to '${autoFields[nextField]}'.` }]);
        nextIndex++;
      } else {
        setCurrentField(nextField);
        setMessages(prev => [...prev, { sender: "bot", text: generateQuestion(nextField) }]);
        return;
      }
    }
    const timestamp = Date.now();
    set(ref(db, `Operations/${timestamp}`), updatedResponses);
    setMessages(prev => [...prev, {
      sender: "bot",
      text: "Awesome! I've logged that for you. If you need to add anything else later, just let me know."
    }]);
    setCurrentField(null);
  };

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      right: 0,
      width: "300px",
      height: "auto",
      background: "white",
      border: "1px solid #ccc",
      borderRadius: "8px",
      padding: "1rem",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      zIndex: 9999
    }}>
      <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>Enterprise Assistant</div>
      <div style={{ maxHeight: "40vh", overflowY: "auto", marginBottom: "0.5rem" }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: msg.sender === "bot" ? "flex-start" : "flex-end" }}>
          <div style={{
            maxWidth: "80%",
            background: msg.sender === "bot" ? "#f1f1f1" : "#007bff",
              color: msg.sender === "bot" ? "black" : "white",
              padding: "0.5rem",
              borderRadius: "8px",
              margin: "0.25rem 0"
            }}>{msg.text}</div>
          </div>
        ))}
        <div ref={chatEndRef}></div>
      </div>
      {currentField && !autoFields[currentField] && (
        <div>
          <input
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUserInput()}
            placeholder="Type your answer..."
            style={{
              width: "100%",
              padding: "0.5rem",
              marginBottom: "0.5rem",
              fontSize: "16px"
            }}
          />
          <button onClick={handleUserInput} style={{ width: "100%", fontSize: "16px" }}>Submit</button>
        </div>
      )}
      <div style={{ marginTop: "0.5rem" }}>
        <button
          onClick={() => window.dispatchEvent(new Event("visualize-fields"))}
          style={{ width: "100%", fontSize: "16px", padding: "0.5rem", background: "#28a745", color: "white", border: "none", borderRadius: "4px" }}
        >
          Visualize Operations
        </button>
      </div>
    </div>
  );
};


export default EnterpriseChatbot;
