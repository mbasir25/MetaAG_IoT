import React, { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { ref, get, child, set } from "firebase/database";
import { getUnsentVisits } from "../storage";
import OpenAI from "openai";
import { saveEnterpriseVisit, clearEnterpriseVisits, getEnterpriseVisits, deleteEnterpriseVisit } from "../enterpriseStorage";
import { logAIMetric } from "../utils/aiMetricsLogger";

const SKIPPED_FIELDS = ["Entry", "Exit", "Fieldname"];
const openai = new OpenAI({
  apiKey: process.env.REACT_APP_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true
});

const EnterpriseChatbot = () => {
  const [messages, setMessages] = useState([]);
  const [userInput, setUserInput] = useState("");
  const [currentField, setCurrentField] = useState(null);
  const [fieldOrder, setFieldOrder] = useState([]);
  const [responses, setResponses] = useState({});
  const [autoFields, setAutoFields] = useState({});
  const [dbTables, setDbTables] = useState({});
  const [valueVectors, setValueVectors] = useState({});
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [correctedMatch, setCorrectedMatch] = useState(null);
  const chatEndRef = useRef(null);
  const [showChat, setShowChat] = useState(false);
  const [tempVisitId, setTempVisitId] = useState(null);


  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // useEffect(() => {
  //   const handler = () => window.location.hash = "#map";
  //   window.addEventListener("visualize-fields", handler);
  //   return () => window.removeEventListener("visualize-fields", handler);
  // }, []);

  const extractKnownValues = (table) => {
    return Object.entries(table).flatMap(([key, value]) => {
      const results = [key];
      if (typeof value === "string") results.push(value);
      else if (typeof value === "object") results.push(...Object.values(value).map(String));
      return results;
    }).filter(Boolean);
  };

  const cosineSimilarity = (a, b) => {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (magA * magB);
  };

  const createEmbedding = async (text) => {
    const res = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: text
    });
    return res.data[0].embedding;
  };
  const resolveTableForField = (fieldKey, dbRoot) => {
      const field = String(fieldKey || "").trim().toLowerCase();
      const tables = Object.keys(dbRoot || {})
        .filter(t => !["eval", "visits", "operations", "template"].includes(t.toLowerCase()));

      // exact / singular-plural-ish match
      let best = tables.find(t => t.toLowerCase() === field);
      if (best) return best;

      best = tables.find(t => t.toLowerCase() === field + "s");
      if (best) return best;

      best = tables.find(t => field === t.toLowerCase() + "s");
      if (best) return best;

      // soft contains match (Activity -> Activities, material -> Materials if you add later)
      best = tables.find(t => t.toLowerCase().includes(field) || field.includes(t.toLowerCase()));
      return best || null;
  };




  useEffect(() => {
    const loadSchemaAndVisits = async () => {
      const [schemaSnap, localVisits, fullDbSnap] = await Promise.all([
        get(child(ref(db), "Operations/template")),
        getEnterpriseVisits(),
        get(ref(db))
      ]);

      if (!schemaSnap.exists()) return;
      const template = schemaSnap.val();
      const keys = Object.keys(template);
      const sortedVisits = [...(localVisits || [])].sort((a, b) => {
        const ta = new Date(a.entryTime || 0).getTime();
        const tb = new Date(b.entryTime || 0).getTime();
        return ta - tb; // oldest first
      });

      const visit = sortedVisits[0];
      setTempVisitId(visit?.id || null);
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

      const allVectors = [];
      for (const [tableName, tableData] of Object.entries(fullDb)) {
        const lower = tableName.toLowerCase();
        if (lower === "eval" || lower === "visits") continue; 

        const values = extractKnownValues(tableData);
        const embeddings = await Promise.all(values.map(v => createEmbedding(v)));
        for (let i = 0; i < values.length; i++) {
          allVectors.push({ field: tableName, text: values[i], vector: embeddings[i] });
        }
      }

      const grouped = {};
      for (const item of allVectors) {
        if (!grouped[item.field]) grouped[item.field] = [];
        grouped[item.field].push(item);
      }
      setValueVectors(grouped);


      const greeting = visit
        ? `Hey there! I noticed you were at the '${visit.polygon}' field around ${new Date(visit.entryTime).toLocaleTimeString()}. Mind if we quickly log what happened?`
        : `Hey there! Ready to log what you just did in the field?`;

      setMessages([{ sender: "bot", text: greeting }]);

      for (const key of ordered) {
        if (autoPrefill[key]) {
          setMessages(prev => [...prev, { sender: "bot", text: `No need to ask — I've already got "${key}" as '${autoPrefill[key]}' 😉` }]);
        } else {
          setMessages(prev => [...prev, { sender: "bot", text: `Alright, could you fill me in on "${key}"?` }]);
          break;
        }
      }
    };

    loadSchemaAndVisits();
  }, []);

  const normalizeEmptyNote = (field, input) => {
    const lower = String(input || "").trim().toLowerCase();
    
    if (
      lower === "" ||
      ["none","no", "no note", "no notes", "nothing", "n/a", "na"].includes(lower)
    ) {
      return "N/A";
    }
    
    return input;
  };

  const semanticMatchRAG = async (field, userValue) => {
    // 1. Spell-check user input using GPT
    const spellPrompt = `Correct any spelling errors in this word or short phrase in the context of agricultural field operations. Respond with the corrected word only: "${userValue}"`;

    const spellRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: spellPrompt }],
        temperature: 0.2
      })
    });

    const spellData = await spellRes.json();
    const correctedText = spellData.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, "") || userValue;

    console.log(`🔠 Spell-corrected input: "${userValue}" → "${correctedText}"`);
    logAIMetric("SpellCorrection", {
      field,
      original: userValue,
      corrected: correctedText
    });

    // 2. Controlled mapping to known DB values using GPT
    const table = resolveTableForField(field, dbTables);
    const candidates = table ? (valueVectors?.[table] || []) : [];

    const knownValues = candidates.map(v => v.text);

    if (!knownValues.length) {
      console.warn(`⚠️ No known values for field "${field}" (table: ${table}). Skipping controlled match.`);
      return { match: false, corrected: correctedText };
    }

    const matchPrompt = `
    You are matching a user's input to a known list of allowed values. You will not look at data inside the key 'eval' and 'visits'.

    User input: "${correctedText}"
    Field: "${field}"
    Known values: ${knownValues.join(", ")}

    Your job:
    - Fix spelling if needed.
    - If the user input is a synonym (e.g., "maize" for "Corn", "Soccer" for "football", "rice" for "paddy" or similar), return the known value in the database knowledge.
    - Only respond with a value from the known list above.
    - If no match, return: NO_MATCH.
    Respond only with the corrected value and nothing else.
    `;

    const matchRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REACT_APP_OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: matchPrompt }],
        temperature: 0.2
      })
    });

    const matchData = await matchRes.json();
    const matchedValue = matchData.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, "");

    if (matchedValue && matchedValue.toUpperCase() !== "NO_MATCH") {
      return {
        match: true,
        corrected: matchedValue
      };
    }

    logAIMetric("ControlledMatch", {
      field,
      input: correctedText,
      match: matchedValue
    });

    
    

    console.log(" Matching in field:", field);
    console.log(" Known options:", candidates.map(v => v.text));

    // 3. Try exact match (case-insensitive)
    const exactMatch = candidates.find(item => item.text.toLowerCase() === correctedText.toLowerCase());
    if (exactMatch) {
      return {
        match: true,
        corrected: exactMatch.text
      };
    }

    // 4. Semantic embedding match
    const userEmbedding = await createEmbedding(correctedText);
    const scored = candidates.map(item => ({
      ...item,
      score: cosineSimilarity(userEmbedding, item.vector)
    })).sort((a, b) => b.score - a.score);

    const topMatch = scored[0];
    const bestScore = topMatch?.score || 0;

    console.log(` Best semantic match: "${topMatch?.text}" with score ${bestScore.toFixed(3)}`);

    const threshold = 0.85;
    if (bestScore >= threshold) {
      return {
        match: true,
        corrected: topMatch.text
      };
    }

    logAIMetric("SemanticSimilarity", {
      field,
      input: correctedText,
      topMatch: topMatch?.text,
      score: bestScore,
      top5: scored.slice(0, 5).map(({ text, score }) => ({ text, score }))
    });

    // 5. Fallback to original corrected text
    console.warn(`⚠️ No confident semantic match. Returning spell-corrected input.`);
    return {
      match: false,
      corrected: correctedText
    };
    
  };

  const proceedToNextField = async (updatedResponses) => {
    const ordered = fieldOrder;
    const nextField = ordered.find(key => !updatedResponses[key]);
    
    const questionVariants = [
      (field) => `Could you please tell me about ${field}?`,
      (field) => `What about ${field}?`,
      (field) => `Now tell me about ${field}.`,
      (field) => `Can you fill in ${field}?`,
      (field) => `Let’s talk about ${field} — what should I record?`,
      (field) => `Do you want to record anything for ${field}?`
    ];



    if (nextField) {
      setCurrentField(nextField);
      const variant = questionVariants[Math.floor(Math.random() * questionVariants.length)];
      setMessages(prev => [...prev, { sender: "bot", text: variant(nextField) }]);
    } else {
      // ✅ All fields filled — show summary and ask to confirm
      setMessages(prev => [
        ...prev,
        { sender: "bot", text: "Here's what I recorded:" },
        ...Object.entries(updatedResponses).map(([k, v]) => ({
          sender: "bot",
          text: `• ${k}: ${v}`
        })),
        { sender: "bot", text: "Do you want to save this? (yes/no)" }
      ]);
      setUserInput("");
      setAwaitingConfirmation(true);
      setCorrectedMatch("__final_submit__"); // special marker for final confirmation
    }
  };

  const isYes = (text) => {
    const lower = String(text || "").trim().toLowerCase();
    return [
      "y", "yes", "yeah", "yup", "yep", "ok", "okay", "sure", "correct", "right", "bet","affirmative"
    ].includes(lower);
  };

  const handleUserInput = async () => {
  if (!userInput.trim()) return;

  if (awaitingConfirmation && correctedMatch !== null) {
    if (isYes(userInput)) {
      if (correctedMatch === "__final_submit__") {
        // ✅ Final confirmation: save to Firebase
        console.log("🟢 Final responses ready to save:", responses);

        const newVisitRef = ref(db, `Operations/${Date.now()}`);
        await set(newVisitRef, responses);
        await deleteEnterpriseVisit(tempVisitId);
         setTempVisitId(null);
         logAIMetric("FinalSave", {
          savedData: responses
        });
        clearEnterpriseVisits();

        // 🧹 Clear local visit cache
        if (typeof window !== "undefined" && window.localStorage) {
          localStorage.removeItem("unsyncedVisits");
        }

        setMessages(prev => [...prev, { sender: "bot", text: "✅ Saved successfully. Thanks!" }]);
        setUserInput("");
        setAwaitingConfirmation(false);
        setCorrectedMatch(null);
        console.log("✅ Data saved to Firebase.");
      } else {
        // ✅ Save a single corrected field
        const updatedResponses = { ...responses, [currentField]: correctedMatch };
        setResponses(updatedResponses);
        setMessages(prev => [...prev, { sender: "bot", text: `Got it. Saved "${correctedMatch}".` }]);
        setUserInput("");
        setAwaitingConfirmation(false);
        setCorrectedMatch(null);
        proceedToNextField(updatedResponses);
      }
    } else {
      // ❌ User said "no"
      if (correctedMatch === "__final_submit__") {
        setMessages(prev => [...prev, { sender: "bot", text: "Okay. What would you like to change?" }]);
      } else {
        logAIMetric("UserRejectedGPTMatch", {
          field: currentField,
          suggested: correctedMatch,
          userSaid: userInput
        });
        setMessages(prev => [...prev, { sender: "bot", text: `Okay, let's try again. What should we log for "${currentField}"?` }]);
      }
      setUserInput("");
      setAwaitingConfirmation(false);
      setCorrectedMatch(null);
    }
    return;
  }

  // Normal field input — run matching
  const preprocessedInput = normalizeEmptyNote(currentField, userInput.trim());
  const matchResult = await semanticMatchRAG(currentField, preprocessedInput);
  const promptSummary = `Did you mean "${matchResult.corrected}" for "${currentField}"? (yes/no)`;

  setCorrectedMatch(matchResult.corrected);
  setUserInput("");
  setAwaitingConfirmation(true);
  setMessages(prev => [
    ...prev,
    { sender: "user", text: userInput.trim() },
    { sender: "bot", text: promptSummary }
  ]);
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
          type="button"
          onClick={() => {
            const target = '#map';
            if (window.location.hash === target) {
              // already on #map → force your hash-based UI to update
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } else {
              window.location.hash = target; // triggers a normal hashchange
            }
          }}
          style={{ width: "100%", fontSize: "16px", padding: "0.5rem", background: "#28a745", color: "white", border: "none", borderRadius: "4px" }}
        >
          Visualize Operations
        </button>
      </div>
    </div>
  );
};

export default EnterpriseChatbot;
