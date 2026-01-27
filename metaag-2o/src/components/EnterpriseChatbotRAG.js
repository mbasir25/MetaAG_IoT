import React, { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { ref, get, child, set } from "firebase/database";
import { getEnterpriseVisits, deleteEnterpriseVisit } from "../enterpriseStorage";
import { logAIMetric } from "../utils/aiMetricsLogger";

const SKIPPED_FIELDS = ["Entry", "Exit", "Fieldname"];
const MIN_VISIT_SECONDS = 20;
// Never use these as reference vocab
const RESERVED_TABLES = new Set(["eval", "visits", "operations", "template", "reg"]);

// If you later want a strict allowlist, put table names here, e.g. ["Activities","Crop","Materials"]
// Leave null to allow all non-reserved tables.
const REFERENCE_ALLOWLIST = null;

const AI_LABEL = "Gemini 2.0 Flash (free, OpenRouter)";
const OPENROUTER_MODEL = "google/gemini-2.0-flash-exp:free";

/**
 * OpenRouter chat completion helper (browser-safe via fetch).
 * NOTE: For production, move the API key to a backend to avoid exposing it in the client bundle.
 */
const callLLM = async ({
  messages,
  temperature = 0,
  model = OPENROUTER_MODEL,
  max_tokens = 256
}) => {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.REACT_APP_OPENROUTER_API_KEY}`,
      "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : undefined,
      "X-Title": "Enterprise Assistant"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: Math.min(Number(max_tokens || 0) || 256, 256) // cap to avoid 402 / runaway output
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = `API error occurred: Status ${res.status}\nBody: ${JSON.stringify(data)}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.delta?.content ??
    ""
  );
};



const EnterpriseChatbot = ({ userId, userName }) => {
  const [messages, setMessages] = useState([]);
  const [userInput, setUserInput] = useState("");

  const [dbTables, setDbTables] = useState({});
  const [fieldOrder, setFieldOrder] = useState([]);
  const [responses, setResponses] = useState({});
  const [autoFields, setAutoFields] = useState({});
  const [currentField, setCurrentField] = useState(null);

  const [tempVisitId, setTempVisitId] = useState(null);

  // whether we have an auto-detected visit from background tracking
  const [hasVisitContext, setHasVisitContext] = useState(false);

  // manual visit entry when no background visit exists
  const [manualFieldname, setManualFieldname] = useState("");
  const [manualEntry, setManualEntry] = useState(""); // datetime-local value
  const [manualExit, setManualExit] = useState(""); // datetime-local value

  // confirm_visit -> paragraph -> fill_missing -> final_confirm -> edit_pick_field -> edit_set_value -> done
  const [stage, setStage] = useState("confirm_visit");

  // confirming suggestions and final save
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [pending, setPending] = useState(null);
  const [pendingQueue, setPendingQueue] = useState([]); // queue of field confirmations
  // pending:
  // { kind: "field", fieldKey, rawValue, suggestedValue }
  // { kind: "final" }
  // { kind: "verify_keep", fieldKey, rawValue, suggestions: [] }

  // edit flow
  const [editFieldKey, setEditFieldKey] = useState(null);

  // rate-unit prompt
  const [pendingUnitField, setPendingUnitField] = useState(null); // e.g. "crop rate"
  const [pendingUnitNumber, setPendingUnitNumber] = useState(null);

  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // -------------------- helpers --------------------

  const normalizeText = (t) =>
    String(t || "")
      .trim()
      .replace(/\s+/g, " ");

  const isYes = (text) => {
    const lower = normalizeText(text).toLowerCase();
    return [
      "y",
      "yes",
      "yeah",
      "yup",
      "yep",
      "ok",
      "okay",
      "sure",
      "correct",
      "right",
      "affirmative"
    ].includes(lower);
  };

  const isNo = (text) => {
    const lower = normalizeText(text).toLowerCase();
    return ["n", "no", "nope", "nah"].includes(lower);
  };

  // Strict "none" tokens (used for short answers)
  const isNoneTextStrict = (text) => {
    const lower = normalizeText(text).toLowerCase();
    return ["none", "nothing", "no", "nan", "n/a", "na"].includes(lower);
  };

  // Broader "none-like" detection (works for phrases like "no crop was planted")
  const isNoneLike = (text) => {
    const lower = normalizeText(text).toLowerCase();
    if (!lower) return true;

    // exact tokens
    if (isNoneTextStrict(lower)) return true;

    // phrases / contains
    if (/\b(nan|n\/a|na)\b/.test(lower)) return true;

    // "no ..." at the start ("no crop was planted", "no material used")
    if (/^no\b/.test(lower)) return true;

    // "didn't / did not / not used / not planted" patterns
    if (/\b(didn['’]?t|did not|not)\b/.test(lower) && /\b(any|use|used|apply|applied|plant|planted)\b/.test(lower)) {
      return true;
    }

    // generic "none/nothing" anywhere
    if (/\b(none|nothing)\b/.test(lower)) return true;

    return false;
  };

  const normalizeEmptyNote = (_field, input) => {
    if (isNoneLike(input) || normalizeText(input) === "") return "N/A";
    return input;
  };

  // If your template uses "crop rate" and "material amount", this keeps it dynamic:
  const findKeyIncludes = (needle) => {
    const n = String(needle || "").toLowerCase();
    return fieldOrder.find((k) => String(k).toLowerCase().includes(n)) || null;
  };

  const getCropKey = () => findKeyIncludes("crop");
  const getCropRateKey = () => findKeyIncludes("crop rate") || findKeyIncludes("rate");
  const getMaterialKey = () => findKeyIncludes("material");
  const getMaterialAmountKey = () => findKeyIncludes("material amount") || findKeyIncludes("amount");

  const isRateField = (fieldKey) => String(fieldKey || "").toLowerCase().includes("rate");

  const isMaterialField = (fieldKey) => String(fieldKey || "").toLowerCase().includes("material");
  const isMaterialAmountField = (fieldKey) => {
    const f = String(fieldKey || "").toLowerCase();
    return f.includes("material") && f.includes("amount");
  };

  const isCropField = (fieldKey) => {
    const f = String(fieldKey || "").toLowerCase();
    return f === "crop" || f.includes(" crop") || f.startsWith("crop");
  };

  const isCropRateField = (fieldKey) =>
    String(fieldKey || "").toLowerCase().includes("crop rate") ||
    (isRateField(fieldKey) && String(fieldKey || "").toLowerCase().includes("crop"));

  const classifyField = (fieldKey) => {
    const f = String(fieldKey || "").toLowerCase();
    if (f.includes("note") || f.includes("comment") || f.includes("remark")) return "free_text";
    if (
      f.includes("rate") ||
      f.includes("amount") ||
      f.includes("qty") ||
      f.includes("quantity") ||
      f.includes("yield") ||
      f.includes("duration")
    )
      return "numeric";
    return "categorical";
  };

  const listReferenceTables = (dbRoot) => {
    const tables = Object.keys(dbRoot || {}).filter((t) => !RESERVED_TABLES.has(String(t).toLowerCase()));
    if (Array.isArray(REFERENCE_ALLOWLIST) && REFERENCE_ALLOWLIST.length) {
      return tables.filter((t) => REFERENCE_ALLOWLIST.includes(t));
    }
    return tables;
  };

  // Small levenshtein helper used only for resolving table names.
  // (We keep it here so resolveTableForField doesn't depend on later declarations.)
  const tableNameDistance = (a, b) => {
    a = String(a || "").toLowerCase();
    b = String(b || "").toLowerCase();
    const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[a.length][b.length];
  };

  // Map template field -> best reference table
  const resolveTableForField = (fieldKey, dbRoot) => {
    const field = String(fieldKey || "").trim().toLowerCase();
    const tables = listReferenceTables(dbRoot);

    // 1) exact
    let best = tables.find((t) => t.toLowerCase() === field);
    if (best) return best;

    // 2) plural: +s
    best = tables.find((t) => t.toLowerCase() === field + "s");
    if (best) return best;

    // 3) plural: y -> ies  (Activity -> Activities)
    if (field.endsWith("y")) {
      const ies = field.slice(0, -1) + "ies";
      best = tables.find((t) => t.toLowerCase() === ies);
      if (best) return best;
    }

    // 4) reverse plural
    best = tables.find((t) => field === t.toLowerCase() + "s");
    if (best) return best;

    // 5) contains
    best = tables.find((t) => t.toLowerCase().includes(field) || field.includes(t.toLowerCase()));
    if (best) return best;

    // 6) fuzzy table-name match as last resort
    const scored = tables
      .map((t) => ({ t, d: tableNameDistance(field, t.toLowerCase()) }))
      .sort((a, b) => a.d - b.d);
    if (scored[0] && scored[0].d <= 2) return scored[0].t;

    return null;
  };

  const isProbablyFreeformCategorical = (fieldKey) => {
    const f = String(fieldKey || "").toLowerCase();
    // common freeform identifiers that shouldn't be constrained to reference vocab
    return (
      f === "name" ||
      f.includes("name") ||
      f.includes("operator") ||
      f.includes("person") ||
      f.includes("farmer") ||
      f.includes("who") ||
      f.includes("by")
    );
  };

  // Global reference vocab fallback (only used when table resolution fails)
  const getGlobalKnownValues = () => {
    const tables = listReferenceTables(dbTables);
    const out = new Set();
    for (const t of tables) {
      const vals = extractKnownValues(dbTables?.[t]);
      for (const v of vals) out.add(String(v).trim());
      // safety: avoid runaway huge lists
      if (out.size > 5000) break;
    }
    return Array.from(out).filter(Boolean);
  };

  const extractKnownValues = (tableData) => {
    if (!tableData) return [];
    const out = [];

    if (Array.isArray(tableData)) {
      for (const v of tableData) {
        if (typeof v === "string") out.push(v);
        else if (v && typeof v === "object") {
          if (v.name) out.push(String(v.name));
          for (const vv of Object.values(v)) {
            if (typeof vv === "string" || typeof vv === "number") out.push(String(vv));
          }
        }
      }
    } else if (typeof tableData === "object") {
      for (const [k, v] of Object.entries(tableData)) {
        const isPushId = typeof k === "string" && k.startsWith("-N");
        if (!isPushId && typeof k === "string") out.push(k);

        if (typeof v === "string") out.push(v);
        else if (v && typeof v === "object") {
          if (v.name) out.push(String(v.name));
          for (const vv of Object.values(v)) {
            if (typeof vv === "string" || typeof vv === "number") out.push(String(vv));
          }
        }
      }
    }

    return [...new Set(out.map((s) => String(s).trim()).filter(Boolean))];
  };

  const editDistance = (a, b) => {
    a = String(a || "").toLowerCase();
    b = String(b || "").toLowerCase();
    const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[a.length][b.length];
  };

  // Deterministic snap: exact or typo (looser for short words like tillas->tillage)
  const bestKnownMatch = (rawValue, knownValues) => {
    const val = String(rawValue || "").trim();
    if (!val || !knownValues?.length) return null;

    const exact = knownValues.find((k) => k.toLowerCase() === val.toLowerCase());
    if (exact) return exact;

    const scored = knownValues
      .map((k) => ({ k, d: editDistance(val, k) }))
      .sort((a, b) => a.d - b.d);

    const best = scored[0];
    if (!best) return null;

    const vL = val.toLowerCase();
    const kL = best.k.toLowerCase();
    const allow = vL.length <= 8 || kL.length <= 8 ? 3 : 2;

    if (best.d <= allow) return best.k;
    return null;
  };

  // Provide a small suggestion list for "verify_keep"
  const topClosest = (rawValue, knownValues, n = 5) => {
    const val = String(rawValue || "").trim();
    if (!val || !knownValues?.length) return [];
    return knownValues
      .map((k) => ({ k, d: editDistance(val, k) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((x) => x.k);
  };

  // Return multiple close matches for ambiguous inputs like "tractor"
  const bestKnownMatches = (rawValue, knownValues, limit = 5) => {
    const val = String(rawValue || "").trim();
    if (!val || !knownValues?.length) return [];
    const vL = val.toLowerCase();

    // Strong signal: substring matches (e.g., "tractor" matches multiple tractors)
    const contains = knownValues.filter((k) => String(k || "").toLowerCase().includes(vL));
    if (contains.length > 1) {
      return contains
        .map((k) => ({ k, d: editDistance(val, k) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map((x) => x.k);
    }

    // Otherwise, use distance threshold near the best match
    const scored = knownValues
      .map((k) => ({ k, d: editDistance(val, k) }))
      .sort((a, b) => a.d - b.d);

    const best = scored[0];
    if (!best) return [];

    const allow = vL.length <= 8 ? 3 : 2;
    const opts = scored
      .filter((x) => x.d <= allow && x.d <= best.d + 1)
      .slice(0, limit)
      .map((x) => x.k);

    return Array.from(new Set(opts));
  };

  // LLM synonym mapping SAFE: must return a value FROM allowed list or NO_MATCH
  const chooseFromAllowedList = async ({ fieldKey, userValue, allowedValues }) => {
    if (!allowedValues?.length) return null;

    const prompt = `
Pick the best match from the Allowed Values list for the user's input.
If none match, respond exactly: NO_MATCH.
Return only ONE value from Allowed Values or NO_MATCH. No other text.

Field: ${fieldKey}
User input: ${userValue}
Allowed Values: ${allowedValues.join(", ")}
`.trim();

    const out = (await callLLM({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 64
    }))
      .trim()
      .replace(/^"|"$/g, "");

    if (!out || out.toUpperCase() === "NO_MATCH") return null;

    const ok = allowedValues.some((v) => String(v).toLowerCase() === out.toLowerCase());
    return ok ? out : null;
  };

  const safeParseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      const m = String(text || "").match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
  };

  // Normalize extractor output keys (case/space) to match template keys exactly
  const buildSchemaKeyMap = (keys) => {
    const map = {};
    for (const k of keys || []) {
      map[String(k).trim().toLowerCase()] = k;
    }
    return map;
  };

  const normalizeExtractedKeys = (extracted, schemaKeyMap) => {
    const out = {};
    for (const [k, v] of Object.entries(extracted || {})) {
      const canon = schemaKeyMap[String(k).trim().toLowerCase()];
      if (!canon) continue;
      out[canon] = v;
    }
    return out;
  };

  const guessNameFromText = (text) => {
    const s = String(text || "");
    const m = s.match(/\b(i am|i'm)\s+([A-Za-z][A-Za-z .'-]{1,40})/i);
    if (!m) return null;
    const raw = m[2].trim();
    // take first token as name
    return raw.split(/\s+/)[0] || null;
  };


  // LLM extraction: ONLY uses template keys; doesn't see DB tables
  const extractFromParagraph = async (paragraph, schemaKeys) => {
    const keyHints = schemaKeys
      .filter((k) => !SKIPPED_FIELDS.includes(k))
      .map((k) => `- ${k} (${classifyField(k)})`)
      .join("\n");

    const system = `
You are a data-entry assistant. Extract structured fields from the user's message.
Return ONLY valid JSON.

Rules:
- Output JSON with keys from the schema list ONLY.
- If a key is not mentioned, omit it.
- For numeric keys (rate/amount/qty/etc): ONLY output the value if the user provided a number. Otherwise omit the key.
- If the user explicitly indicates none/nothing/no/nan/n/a for a field, output "N/A" for that key.
- Keep user-provided units if present (e.g., "1200 nos./acre").
- Do not invent data.
`.trim();

    const user = `
Schema keys:
${keyHints}

User message:
${paragraph}

Return JSON with detected keys/values only.
`.trim();

    const content =
      (await callLLM({
        temperature: 0,
        max_tokens: 256,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })) || "{}";

    return safeParseJson(content) || {};
  };

  const nextMissingField = (updatedResponses) => {
    return fieldOrder.find((k) => {
      if (SKIPPED_FIELDS.includes(k)) return false;
      const v = updatedResponses[k];
      return v === undefined || String(v).trim() === "";
    });
  };

  const buildSummaryMessages = (finalResponses) => {
    return [
      { sender: "bot", text: "Here's what I recorded:" },
      ...Object.entries(finalResponses).map(([k, v]) => ({ sender: "bot", text: `• ${k}: ${v}` })),
      { sender: "bot", text: "Save this? (yes/no)" }
    ];
  };

  // -------- numeric parsing + normalization (rate) --------

  const parseNumberAndUnit = (text) => {
    const s = String(text || "").toLowerCase();

    // explicit none-like
    if (isNoneLike(s)) return { num: null, unit: null, isNone: true };

    // capture first number (supports 1,220 or 1220.5)
    const numMatch = s.match(/(\d[\d,]*\.?\d*)/);
    if (!numMatch) return { num: null, unit: null, isNone: false };

    const num = Number(numMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) return { num: null, unit: null, isNone: false };

    const hasAcre = /\/\s*acre|per\s*acre|\bacre\b/.test(s);
    const hasHa = /\/\s*ha|\/\s*hectare|per\s*ha|per\s*hectare|\bha\b|\bhectare\b/.test(s);

    let unit = null;
    if (hasHa) unit = "nos./ha";
    else if (hasAcre) unit = "nos./acre";
    else unit = null;

    return { num, unit, isNone: false };
  };

  const convertRateToAcre = (num, unit) => {
    if (num === null || num === undefined || !unit) return null;
    // 1 hectare = 2.47105 acres
    if (unit === "nos./ha") return num / 2.47105;
    if (unit === "nos./acre") return num;
    return null;
  };

  const formatNosPerAcre = (num) => {
    if (num === null || num === undefined) return "";
    const rounded = Math.round(num);
    return `${rounded} nos./acre`;
  };

  // Snap a single categorical field value to references safely
  const snapFieldValue = async (fieldKey, rawValue) => {
    const fieldType = classifyField(fieldKey);
    let val = rawValue;

    // free text
    if (fieldType === "free_text") {
      val = normalizeEmptyNote(fieldKey, val);
      return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
    }

    // numeric: do not snap (handled elsewhere)
    if (fieldType === "numeric") {
      // if user gave none-like text, record N/A; else keep as-is (caller should parse)
      if (isNoneLike(val)) return { finalValue: "N/A", suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
      return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
    }

    // categorical: if none-like, store N/A
    if (isNoneLike(val)) {
      return { finalValue: "N/A", suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
    }

    const table = resolveTableForField(fieldKey, dbTables);
    // If we can't resolve a table, try global reference vocab (but don't constrain freeform categorical fields like Name)
    if (!table) {
      if (isProbablyFreeformCategorical(fieldKey)) {
        return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
      }

      const globalValues = getGlobalKnownValues();
      if (!globalValues.length) {
        // No references available; ask user to verify instead of silently accepting
        return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: true, suggestions: [] };
      }

      // If multiple plausible matches exist (e.g., user typed a generic term), ask user to choose
      const options = bestKnownMatches(val, globalValues, 5);
      if (options.length > 1) {
        return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, needsDisambiguation: true, options };
      }

      // Try deterministic + GPT snap against global vocab
      let snapped = bestKnownMatch(val, globalValues);
      if (!snapped) {
        try {
          // Limit to a smaller candidate list to keep the prompt manageable
          const shortlist = topClosest(val, globalValues, 50);
          snapped = await chooseFromAllowedList({ fieldKey, userValue: val, allowedValues: shortlist });
        } catch {
          snapped = null;
        }
      }

      if (snapped && snapped.toLowerCase() !== String(val).trim().toLowerCase()) {
        return { finalValue: snapped, suggestedValue: snapped, didSnap: true, needsVerify: false, suggestions: [] };
      }

      const suggestions = topClosest(val, globalValues, 5);
      return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: true, suggestions };
    }

    const knownValues = extractKnownValues(dbTables?.[table]);
    if (!knownValues.length) {
      // Table exists but is empty; fall back to global vocab (same logic)
      if (isProbablyFreeformCategorical(fieldKey)) {
        return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
      }

      const globalValues = getGlobalKnownValues();
      if (!globalValues.length) {
        return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: true, suggestions: [] };
      }

      // If multiple plausible matches exist (e.g., user typed a generic term), ask user to choose
      const options = bestKnownMatches(val, globalValues, 5);
      if (options.length > 1) {
        return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, needsDisambiguation: true, options };
      }

      let snapped = bestKnownMatch(val, globalValues);
      if (!snapped) {
        try {
          const shortlist = topClosest(val, globalValues, 50);
          snapped = await chooseFromAllowedList({ fieldKey, userValue: val, allowedValues: shortlist });
        } catch {
          snapped = null;
        }
      }

      if (snapped && snapped.toLowerCase() !== String(val).trim().toLowerCase()) {
        return { finalValue: snapped, suggestedValue: snapped, didSnap: true, needsVerify: false, suggestions: [] };
      }

      const suggestions = topClosest(val, globalValues, 5);
      return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: true, suggestions };
    }

    // If exact known, accept immediately
    const exact = knownValues.find((k) => k.toLowerCase() === String(val).trim().toLowerCase());
    if (exact) {
      return { finalValue: exact, suggestedValue: null, didSnap: false, needsVerify: false, suggestions: [] };
    }


    // If multiple plausible matches exist (e.g., user typed a generic term), ask user to choose
    const options = bestKnownMatches(val, knownValues, 5);
    if (options.length > 1) {
      return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: false, needsDisambiguation: true, options };
    }

    // 1) exact/typo snap (this covers tillas/tills -> tillage if tillage exists)
    let snapped = bestKnownMatch(val, knownValues);

    // 2) synonym snap via GPT (safe)
    if (!snapped) {
      try {
        snapped = await chooseFromAllowedList({
          fieldKey,
          userValue: val,
          allowedValues: knownValues
        });
      } catch {
        snapped = null;
      }
    }

    // If snapped is a different known value, ask for confirmation (existing behavior)
    if (snapped && snapped.toLowerCase() !== String(val).trim().toLowerCase()) {
      return { finalValue: snapped, suggestedValue: snapped, didSnap: true, needsVerify: false, suggestions: [] };
    }

    // No match at all: ask user to verify (keep-as-is vs re-enter)
    const suggestions = topClosest(val, knownValues, 5);
    return { finalValue: val, suggestedValue: null, didSnap: false, needsVerify: true, suggestions };
  };

  // If crop/material are N/A, auto-fill dependent rate/amount to N/A and don't ask them
  const applyDependencyAutoFill = (obj) => {
    const cropKey = getCropKey();
    const cropRateKey = getCropRateKey();
    const materialKey = getMaterialKey();
    const materialAmountKey = getMaterialAmountKey();

    const out = { ...obj };

    if (cropKey && cropRateKey) {
      const cropVal = out[cropKey];
      if (cropVal && String(cropVal).trim().toLowerCase() === "n/a") {
        out[cropRateKey] = "N/A";
      }
    }

    if (materialKey && materialAmountKey) {
      const matVal = out[materialKey];
      if (matVal && String(matVal).trim().toLowerCase() === "n/a") {
        out[materialAmountKey] = "N/A";
      }
    }

    return out;
  };

  // -------------------- load schema + oldest visit + db --------------------

  useEffect(() => {
    const load = async () => {
      const [schemaSnap, localVisits, fullDbSnap] = await Promise.all([
        get(child(ref(db), "Operations/template")),
        getEnterpriseVisits(userId),
        get(ref(db))
      ]);

      if (!schemaSnap.exists()) return;

      const template = schemaSnap.val();
      const keys = Object.keys(template);

      const fullDb = fullDbSnap.exists() ? fullDbSnap.val() : {};
      setDbTables(fullDb);

      const allVisits = Array.isArray(localVisits) ? localVisits : [];
      const hasAnyVisitRecords = allVisits.length > 0; // optional: for messaging later

      // only visits that have BOTH entry and exit
      const finalized = allVisits.filter((v) => v?.entryTime && v?.exitTime);

      // filter out jitter fragments
      const stable = finalized.filter((v) => {
      const ms = new Date(v.exitTime).getTime() - new Date(v.entryTime).getTime();
      return Number.isFinite(ms) && ms >= MIN_VISIT_SECONDS * 1000;
      });

      // oldest-first (keep your behavior)
      const sortedVisits = [...stable].sort((a, b) => {
      const ta = new Date(a.entryTime || 0).getTime();
      const tb = new Date(b.entryTime || 0).getTime();
      return ta - tb;
    });

    const visit = sortedVisits[0] || null;

    const hasVisit = !!visit;
    setHasVisitContext(hasVisit);
    setTempVisitId(visit?.id || null);

    // optional: keep this in state if you want different text when “waiting for exit”
    

      const autoPrefill = visit
        ? {
            Entry: visit.entryTime || "",
            Exit: visit.exitTime || "",
            Fieldname: visit.polygon || ""
          }
        : {};

      // name auto-fill from login (so the bot doesn't ask again)
      const nameKey = keys.find((k) => String(k).trim().toLowerCase() === "name") || null;
      if (nameKey && userName) {
        autoPrefill[nameKey] = userName;
      }

      // duration auto-fill
      if (keys.some((k) => String(k).toLowerCase().includes("duration")) && visit?.entryTime && visit?.exitTime) {
        const durationMs = new Date(visit.exitTime) - new Date(visit.entryTime);
        const durationMin = Math.round(durationMs / 60000);
        autoPrefill["Duration"] = `${durationMin} minutes`;
      }

      const ordered = keys.filter((k) => !SKIPPED_FIELDS.includes(k)).concat(SKIPPED_FIELDS);

      setFieldOrder(ordered);
      setResponses(autoPrefill);
      setAutoFields(autoPrefill);

      const greet = visit
        ? `I see you were at "${autoPrefill.Fieldname}" around ${new Date(autoPrefill.Entry).toLocaleTimeString()}. Do you want to log what you did there? (yes/no)`
        : `I don't see a recent tracked visit to log. Do you want to manually log an operation now? (yes/no)`;

      setStage("confirm_visit");
      setCurrentField(null);
      setAwaitingConfirmation(false);
      setPending(null);
      setEditFieldKey(null);
      setPendingUnitField(null);
      setPendingUnitNumber(null);

      setMessages([{ sender: "bot", text: greet }]);
    };

    load();
  }, []);

  // -------------------- confirmation queue helpers --------------------
  const promptForPending = (item) => {
    if (!item) return;

    if (item.kind === "field") {
      setMessages((prev) => [...prev, { sender: "bot", text: `Did you mean "${item.suggestedValue}" for "${item.fieldKey}"? (yes/no)` }]);
      return;
    }

    if (item.kind === "verify_keep") {
      const sugg = item.suggestions?.length ? `
Suggestions: ${item.suggestions.join(", ")}` : "";
      setMessages((prev) => [
        ...prev,
        {
          sender: "bot",
          text: `I couldn't match "${item.rawValue}" to known values for "${item.fieldKey}". Keep it as-is? (yes/no)${sugg}`
        }
      ]);
      return;
    }

    if (item.kind === "pick_one") {
      const opts = (item.options || []).slice(0, 5);
      const list = opts.map((o, i) => `${i + 1}) ${o}`).join("\n");
      setMessages((prev) => [
        ...prev,
        {
          sender: "bot",
          text:
            `I found multiple matches for "${item.rawValue}" in "${item.fieldKey}". Which one did you mean?
` +
            `0) None of these (keep as typed)
` +
            (list ? (list + "\n") : "") +
            `Reply with the number (0-${opts.length}) or type the exact value.`
        }
      ]);
      return;
    }
  };

  const proceedAfterUpdates = (baseResponses, queue = []) => {
    // Always apply dependency auto-fill first
    let updated = applyDependencyAutoFill({ ...(baseResponses || {}) });

    // If we have confirmations to process, do them before asking for missing fields
    if (queue && queue.length) {
      setResponses(updated);
      setPendingQueue(queue);
      setPending(queue[0]);
      setAwaitingConfirmation(true);
      setStage("fill_missing");
      setCurrentField(null);
      promptForPending(queue[0]);
      return;
    }

    // Auto-skip dependent fields (crop rate / material amount) when parent is N/A
    let next = nextMissingField(updated);
    while (next) {
      if (isCropRateField(next)) {
        const cropKey = getCropKey();
        const cropVal = cropKey ? updated[cropKey] : null;
        if (cropVal && String(cropVal).trim().toLowerCase() === "n/a") {
          updated = applyDependencyAutoFill({ ...updated, [next]: "N/A" });
          next = nextMissingField(updated);
          continue;
        }
      }
      if (isMaterialAmountField(next)) {
        const materialKey = getMaterialKey();
        const matVal = materialKey ? updated[materialKey] : null;
        if (matVal && String(matVal).trim().toLowerCase() === "n/a") {
          updated = applyDependencyAutoFill({ ...updated, [next]: "N/A" });
          next = nextMissingField(updated);
          continue;
        }
      }
      break;
    }

    setResponses(updated);

    if (next) {
      setStage("fill_missing");
      setCurrentField(next);
      setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
      return;
    }

    setStage("final_confirm");
    setCurrentField(null);
    setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
    setPending({ kind: "final" });
    setAwaitingConfirmation(true);
  };

  // -------------------- main handler --------------------

  const handleUserInput = async () => {
    const raw = userInput.trim();
    if (!raw) return;

    setMessages((prev) => [...prev, { sender: "user", text: raw }]);
    setUserInput("");

    // If we're waiting for a unit answer (acre/ha) for a RATE field only
    if (pendingUnitField && pendingUnitNumber !== null) {
      const ans = raw.toLowerCase();
      let unit = null;
      if (ans.includes("acre")) unit = "nos./acre";
      if (ans === "ha" || ans.includes("hect")) unit = "nos./ha";

      if (!unit) {
        setMessages((prev) => [...prev, { sender: "bot", text: `Please reply "acre" or "ha".` }]);
        return;
      }

      // If num is 0, don't care about units
      const normalized = pendingUnitNumber === 0 ? "0 nos./acre" : formatNosPerAcre(convertRateToAcre(pendingUnitNumber, unit));

      const updated = applyDependencyAutoFill({ ...responses, [pendingUnitField]: normalized });
      setResponses(updated);

      setPendingUnitField(null);
      setPendingUnitNumber(null);

      const next = nextMissingField(updated);
      if (next) {
        setStage("fill_missing");
        setCurrentField(next);
        setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
      } else {
        setStage("final_confirm");
        setCurrentField(null);
        setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
        setPending({ kind: "final" });
        setAwaitingConfirmation(true);
      }
      return;
    }
    // awaiting yes/no confirmation
    if (awaitingConfirmation && pending) {
      // Field confirmations are handled via pendingQueue (first item is in `pending`).
      // NEW: disambiguation selection (not yes/no)
      if (pending.kind === "pick_one") {
        const opts = pending.options || [];
        const txt = normalizeText(raw);
        const n = Number(txt);

        let chosen = null;
        if (Number.isInteger(n)) {
          if (n === 0) chosen = pending.rawValue; // keep as typed
          else if (n >= 1 && n <= opts.length) chosen = opts[n - 1];
        }

        if (!chosen) {
          chosen = opts.find((o) => o.toLowerCase() === txt.toLowerCase()) || null;
        }

        if (!chosen) {
          setMessages((prev) => [
            ...prev,
            { sender: "bot", text: `Please reply with a number (0-${Math.min(5, opts.length)}) or type one of the options exactly.` }
          ]);
          return;
        }

        const updated = applyDependencyAutoFill({ ...responses, [pending.fieldKey]: chosen });
        const rest = (pendingQueue || []).slice(1);
        setResponses(updated);

        setMessages((prev) => [...prev, { sender: "bot", text: `Okay — I'll record "${pending.fieldKey}" as "${chosen}".` }]);

        if (rest.length) {
          setPendingQueue(rest);
          setPending(rest[0]);
          setAwaitingConfirmation(true);
          promptForPending(rest[0]);
          return;
        }

        setPendingQueue([]);
        setPending(null);
        setAwaitingConfirmation(false);
        proceedAfterUpdates(updated, []);
        return;
      }

      if (isYes(raw)) {
        if (pending.kind === "field") {
          const updated = applyDependencyAutoFill({ ...responses, [pending.fieldKey]: pending.suggestedValue });
          const rest = (pendingQueue || []).slice(1);
          setResponses(updated);

          setMessages((prev) => [...prev, { sender: "bot", text: `Okay — I'll record "${pending.fieldKey}" as "${pending.suggestedValue}".` }]);

          if (rest.length) {
            setPendingQueue(rest);
            setPending(rest[0]);
            setAwaitingConfirmation(true);
            promptForPending(rest[0]);
            return;
          }

          setPendingQueue([]);
          setPending(null);
          setAwaitingConfirmation(false);
          proceedAfterUpdates(updated, []);
          return;
        }

        if (pending.kind === "verify_keep") {
          const updated = applyDependencyAutoFill({ ...responses, [pending.fieldKey]: pending.rawValue });
          const rest = (pendingQueue || []).slice(1);
          setResponses(updated);

          setMessages((prev) => [...prev, { sender: "bot", text: `Got it — I'll keep "${pending.fieldKey}" as "${pending.rawValue}".` }]);

          if (rest.length) {
            setPendingQueue(rest);
            setPending(rest[0]);
            setAwaitingConfirmation(true);
            promptForPending(rest[0]);
            return;
          }

          setPendingQueue([]);
          setPending(null);
          setAwaitingConfirmation(false);
          proceedAfterUpdates(updated, []);
          return;
        }

        if (pending.kind === "final") {
          const newVisitRef = ref(db, `Operations/${Date.now()}`);
          await set(newVisitRef, responses);
          logAIMetric("FinalSave", { savedData: responses });

          if (tempVisitId) {
            await deleteEnterpriseVisit(userId, tempVisitId);
            setTempVisitId(null);
          }

          setAwaitingConfirmation(false);
          setPending(null);
          setPendingQueue([]);
          setStage("done");
          setMessages((prev) => [...prev, { sender: "bot", text: "✅ Saved successfully. Thanks!" }]);
          return;
        }
      }

      if (isNo(raw)) {
        if (pending.kind === "field") {
          const updated = applyDependencyAutoFill({
            ...responses,
            [pending.fieldKey]: isNoneLike(pending.rawValue) ? "N/A" : pending.rawValue
          });
          const rest = (pendingQueue || []).slice(1);
          setResponses(updated);

          setMessages((prev) => [...prev, { sender: "bot", text: `Got it — I'll keep "${pending.fieldKey}" as "${updated[pending.fieldKey]}".` }]);

          if (rest.length) {
            setPendingQueue(rest);
            setPending(rest[0]);
            setAwaitingConfirmation(true);
            promptForPending(rest[0]);
            return;
          }

          setPendingQueue([]);
          setPending(null);
          setAwaitingConfirmation(false);
          proceedAfterUpdates(updated, []);
          return;
        }

        if (pending.kind === "verify_keep") {
          // user does NOT want to keep as-is -> ask them to re-enter and show suggestions
          const sugg = pending.suggestions?.length ? `
Suggestions: ${pending.suggestions.join(", ")}` : "";
          setAwaitingConfirmation(false);
          setPending(null);
          setPendingQueue([]);

          setStage("fill_missing");
          setCurrentField(pending.fieldKey);
          setMessages((prev) => [
            ...prev,
            { sender: "bot", text: `Okay — please re-enter "${pending.fieldKey}".${sugg}
(Or say "none")` }
          ]);
          return;
        }

        if (pending.kind === "final") {
          setAwaitingConfirmation(false);
          setPending(null);
          setStage("edit_pick_field");
          setMessages((prev) => [...prev, { sender: "bot", text: "Okay — which field do you want to change? (type the field name)" }]);
          return;
        }
      }

      setMessages((prev) => [...prev, { sender: "bot", text: "Please reply yes or no." }]);
      return;
    }

    // confirm visit
    if (stage === "confirm_visit") {
      if (isNo(raw)) {
        setStage("done");
        setMessages((prev) => [...prev, { sender: "bot", text: "Okay — I won’t log anything." }]);
        return;
      }
      if (!isYes(raw)) {
        setMessages((prev) => [...prev, { sender: "bot", text: "Please reply yes or no — do you want to log this visit?" }]);
        return;
      }
      if (!hasVisitContext) {
        setStage("manual_visit");
        setMessages((prev) => [
          ...prev,
          { sender: "bot", text: "Okay. Please enter the Field name, Entry time, and Exit time below, then click \"Continue\"." }
        ]);
        return;
      }


      setStage("paragraph");
      setMessages((prev) => [
        ...prev,
        {
            sender: "bot",
            text:
                `Great${userName ? `, ${userName}` : ""}. Tell me what you did in one message (a paragraph is fine). Example:\n` +
                `"I did Planting. My crop was maize, crop rate was 1200 nos./acre, and I used pesticides."`
            }

      ]);
      return;
    }
    // paragraph stage
    if (stage === "paragraph") {
      const extractedRaw = await extractFromParagraph(raw, fieldOrder);
      const schemaKeyMap = buildSchemaKeyMap(fieldOrder);
      const extracted = normalizeExtractedKeys(extractedRaw, schemaKeyMap);

      // If the model didn't emit Name but user wrote "I am X", fill it.
      if (!extracted["Name"]) {
        const guessed = guessNameFromText(raw);
        if (guessed) extracted["Name"] = guessed;
      }

      logAIMetric("ParagraphExtract", { extracted });

      let updated = { ...responses };
      const queue = [];

      for (const [k, v0] of Object.entries(extracted || {})) {
        if (!fieldOrder.includes(k)) continue;
        if (SKIPPED_FIELDS.includes(k)) continue;
        if (autoFields[k]) continue;

        const v = v0;

        if (classifyField(k) === "free_text") {
          updated[k] = normalizeEmptyNote(k, v);
          continue;
        }

        if (classifyField(k) === "numeric") {
          if (isNoneLike(v)) {
            updated[k] = "N/A";
            continue;
          }

          if (isRateField(k)) {
            const { num, unit, isNone } = parseNumberAndUnit(v);
            if (isNone) {
              updated[k] = "N/A";
              continue;
            }
            if (num === null) continue;
            if (num === 0) {
              updated[k] = "0 nos./acre";
              continue;
            }
            if (!unit) continue;
            updated[k] = formatNosPerAcre(convertRateToAcre(num, unit));
            continue;
          }

          const { num, isNone } = parseNumberAndUnit(v);
          if (isNone) {
            updated[k] = "N/A";
            continue;
          }
          if (num === null) continue;
          updated[k] = String(Math.round(num));
          continue;
        }

        // categorical
        if (isNoneLike(v)) {
          updated[k] = "N/A";
          continue;
        }

        const snap = await snapFieldValue(k, v);

        if (snap.didSnap) {
          queue.push({ kind: "field", fieldKey: k, rawValue: v, suggestedValue: snap.finalValue });
          continue;
        }

        if (snap.needsDisambiguation) {
          queue.push({ kind: "pick_one", fieldKey: k, rawValue: String(v).trim(), options: snap.options || [] });
          continue;
        }

        if (snap.needsVerify) {
          queue.push({ kind: "verify_keep", fieldKey: k, rawValue: String(v).trim(), suggestions: snap.suggestions || [] });
          continue;
        }

        updated[k] = snap.finalValue;
      }

      // Commit everything we safely know, then run queued confirmations (if any), then proceed.
      proceedAfterUpdates(updated, queue);
      return;
    }

    // fill missing
    if (stage === "fill_missing" && currentField) {
      const key = currentField;

      // If crop is N/A, do not ask crop rate; auto-fill crop rate N/A
      if (isCropRateField(key)) {
        const cropKey = getCropKey();
        const cropVal = cropKey ? responses[cropKey] : null;
        if (cropVal && String(cropVal).trim().toLowerCase() === "n/a") {
          const updated = applyDependencyAutoFill({ ...responses, [key]: "N/A" });
          setResponses(updated);

          const next = nextMissingField(updated);
          if (next) {
            setCurrentField(next);
            setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
          } else {
            setStage("final_confirm");
            setCurrentField(null);
            setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
            setPending({ kind: "final" });
            setAwaitingConfirmation(true);
          }
          return;
        }
      }

      // If material is N/A, do not ask material amount; auto-fill N/A
      if (isMaterialAmountField(key)) {
        const materialKey = getMaterialKey();
        const matVal = materialKey ? responses[materialKey] : null;
        if (matVal && String(matVal).trim().toLowerCase() === "n/a") {
          const updated = applyDependencyAutoFill({ ...responses, [key]: "N/A" });
          setResponses(updated);

          const next = nextMissingField(updated);
          if (next) {
            setCurrentField(next);
            setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
          } else {
            setStage("final_confirm");
            setCurrentField(null);
            setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
            setPending({ kind: "final" });
            setAwaitingConfirmation(true);
          }
          return;
        }
      }

      // If user indicates no crop, set crop N/A and auto-fill crop rate N/A (if exists)
      if (isCropField(key) && isNoneLike(raw)) {
        const updated0 = { ...responses, [key]: "N/A" };
        const cropRateKey = getCropRateKey();
        if (cropRateKey) updated0[cropRateKey] = "N/A";
        const updated = applyDependencyAutoFill(updated0);
        setResponses(updated);

        const next = nextMissingField(updated);
        if (next) {
          setCurrentField(next);
          setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
        } else {
          setStage("final_confirm");
          setCurrentField(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
        }
        return;
      }

      // If user indicates no material, set material N/A and auto-fill material amount N/A
      if (isMaterialField(key) && !isMaterialAmountField(key) && isNoneLike(raw)) {
        const updated0 = { ...responses, [key]: "N/A" };
        const amountKey = getMaterialAmountKey();
        if (amountKey) updated0[amountKey] = "N/A";
        const updated = applyDependencyAutoFill(updated0);
        setResponses(updated);

        const next = nextMissingField(updated);
        if (next) {
          setCurrentField(next);
          setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
        } else {
          setStage("final_confirm");
          setCurrentField(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
        }
        return;
      }

      // free text
      if (classifyField(key) === "free_text") {
        const updated = { ...responses, [key]: normalizeEmptyNote(key, raw) };
        setResponses(updated);

        const next = nextMissingField(updated);
        if (next) {
          setCurrentField(next);
          setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
        } else {
          setStage("final_confirm");
          setCurrentField(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
        }
        return;
      }

      // numeric fields: ONLY record numeric, else N/A when none-like present
      if (classifyField(key) === "numeric") {
        if (isNoneLike(raw)) {
          const updated = applyDependencyAutoFill({ ...responses, [key]: "N/A" });
          setResponses(updated);

          const next = nextMissingField(updated);
          if (next) {
            setCurrentField(next);
            setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
          } else {
            setStage("final_confirm");
            setCurrentField(null);
            setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
            setPending({ kind: "final" });
            setAwaitingConfirmation(true);
          }
          return;
        }

        const { num, unit } = parseNumberAndUnit(raw);

        if (num === null) {
          setMessages((prev) => [
            ...prev,
            { sender: "bot", text: `I couldn't find a number for "${key}". Please enter a numeric value or say "none".` }
          ]);
          return;
        }

        // RATE: normalize to nos./acre; if unit missing ask; but if 0, don't ask
        if (isRateField(key)) {
          if (num === 0) {
            const updated = applyDependencyAutoFill({ ...responses, [key]: "0 nos./acre" });
            setResponses(updated);

            const next = nextMissingField(updated);
            if (next) {
              setCurrentField(next);
              setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
            } else {
              setStage("final_confirm");
              setCurrentField(null);
              setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
              setPending({ kind: "final" });
              setAwaitingConfirmation(true);
            }
            return;
          }

          if (!unit) {
            setPendingUnitField(key);
            setPendingUnitNumber(num);
            setMessages((prev) => [...prev, { sender: "bot", text: `Got ${num}. Is that per acre or per hectare? (acre/ha)` }]);
            return;
          }

          const normalized = formatNosPerAcre(convertRateToAcre(num, unit));
          const updated = applyDependencyAutoFill({ ...responses, [key]: normalized });
          setResponses(updated);

          const next = nextMissingField(updated);
          if (next) {
            setCurrentField(next);
            setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
          } else {
            setStage("final_confirm");
            setCurrentField(null);
            setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
            setPending({ kind: "final" });
            setAwaitingConfirmation(true);
          }
          return;
        }

        // NON-rate numeric: store number only
        const updated = applyDependencyAutoFill({ ...responses, [key]: String(Math.round(num)) });
        setResponses(updated);

        const next = nextMissingField(updated);
        if (next) {
          setCurrentField(next);
          setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
        } else {
          setStage("final_confirm");
          setCurrentField(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
        }
        return;
      }

      // categorical
      if (isNoneLike(raw)) {
        const updated = applyDependencyAutoFill({ ...responses, [key]: "N/A" });
        setResponses(updated);

        const next = nextMissingField(updated);
        if (next) {
          setCurrentField(next);
          setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
        } else {
          setStage("final_confirm");
          setCurrentField(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
        }
        return;
      }

      const snap = await snapFieldValue(key, raw);

      if (snap.didSnap) {
        setPending({ kind: "field", fieldKey: key, rawValue: raw, suggestedValue: snap.finalValue });
        setAwaitingConfirmation(true);
        setMessages((prev) => [...prev, { sender: "bot", text: `Did you mean "${snap.finalValue}" for "${key}"? (yes/no)` }]);
        return;
      }

      if (snap.needsDisambiguation) {
        const item = { kind: "pick_one", fieldKey: key, rawValue: String(raw).trim(), options: snap.options || [] };
        setResponses(responses);
        setPendingQueue([item]);
        setPending(item);
        setAwaitingConfirmation(true);
        setStage("fill_missing");
        setCurrentField(null);
        promptForPending(item);
        return;
      }

      if (snap.needsVerify) {
        setPending({ kind: "verify_keep", fieldKey: key, rawValue: String(raw).trim(), suggestions: snap.suggestions || [] });
        setAwaitingConfirmation(true);
        const sugg = snap.suggestions?.length ? `\nSuggestions: ${snap.suggestions.join(", ")}` : "";
        setMessages((prev) => [
          ...prev,
          { sender: "bot", text: `I couldn't match "${String(raw).trim()}" to known values for "${key}". Keep it as-is? (yes/no)${sugg}` }
        ]);
        return;
      }

      const updated = applyDependencyAutoFill({ ...responses, [key]: snap.finalValue });
      setResponses(updated);

      const next = nextMissingField(updated);
      if (next) {
        setCurrentField(next);
        setMessages((prev) => [...prev, { sender: "bot", text: `Anything to record for "${next}"? (you can say "none")` }]);
      } else {
        setStage("final_confirm");
        setCurrentField(null);
        setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
        setPending({ kind: "final" });
        setAwaitingConfirmation(true);
      }
      return;
    }

    // edit flow pick field
    if (stage === "edit_pick_field") {
      const userField = raw.toLowerCase();
      const candidates = fieldOrder.filter((k) => !SKIPPED_FIELDS.includes(k));
      const found =
        candidates.find((k) => k.toLowerCase() === userField) ||
        candidates.find((k) => k.toLowerCase().includes(userField) || userField.includes(k.toLowerCase()));

      if (!found) {
        setMessages((prev) => [...prev, { sender: "bot", text: "I couldn't find that field name. Please type one of the fields shown in the summary." }]);
        return;
      }

      setEditFieldKey(found);
      setStage("edit_set_value");
      setMessages((prev) => [...prev, { sender: "bot", text: `What should "${found}" be?` }]);
      return;
    }

    // edit flow set value
    if (stage === "edit_set_value" && editFieldKey) {
      const key = editFieldKey;

      // numeric edit: reuse same rules as fill_missing
      if (classifyField(key) === "numeric") {
        if (isNoneLike(raw)) {
          const updated = applyDependencyAutoFill({ ...responses, [key]: "N/A" });
          setResponses(updated);

          setStage("final_confirm");
          setEditFieldKey(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
          return;
        }

        const { num, unit } = parseNumberAndUnit(raw);
        if (num === null) {
          setMessages((prev) => [...prev, { sender: "bot", text: `I couldn't find a number for "${key}". Please enter a number or "none".` }]);
          return;
        }

        if (isRateField(key)) {
          if (num === 0) {
            const updated = applyDependencyAutoFill({ ...responses, [key]: "0 nos./acre" });
            setResponses(updated);

            setStage("final_confirm");
            setEditFieldKey(null);
            setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
            setPending({ kind: "final" });
            setAwaitingConfirmation(true);
            return;
          }

          if (!unit) {
            setPendingUnitField(key);
            setPendingUnitNumber(num);
            setEditFieldKey(null);
            setStage("final_confirm");
            setMessages((prev) => [...prev, { sender: "bot", text: `Got ${num}. Is that per acre or per hectare? (acre/ha)` }]);
            return;
          }

          const normalized = formatNosPerAcre(convertRateToAcre(num, unit));
          const updated = applyDependencyAutoFill({ ...responses, [key]: normalized });
          setResponses(updated);

          setStage("final_confirm");
          setEditFieldKey(null);
          setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
          setPending({ kind: "final" });
          setAwaitingConfirmation(true);
          return;
        }

        const updated = applyDependencyAutoFill({ ...responses, [key]: String(Math.round(num)) });
        setResponses(updated);

        setStage("final_confirm");
        setEditFieldKey(null);
        setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
        setPending({ kind: "final" });
        setAwaitingConfirmation(true);
        return;
      }

      // free text edit
      if (classifyField(key) === "free_text") {
        const updated = applyDependencyAutoFill({ ...responses, [key]: normalizeEmptyNote(key, raw) });
        setResponses(updated);

        setStage("final_confirm");
        setEditFieldKey(null);
        setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
        setPending({ kind: "final" });
        setAwaitingConfirmation(true);
        return;
      }

      // categorical edit
      if (isNoneLike(raw)) {
        const updated = applyDependencyAutoFill({ ...responses, [key]: "N/A" });
        setResponses(updated);

        setStage("final_confirm");
        setEditFieldKey(null);
        setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
        setPending({ kind: "final" });
        setAwaitingConfirmation(true);
        return;
      }

      const snap = await snapFieldValue(key, raw);
      if (snap.didSnap) {
        setPending({ kind: "field", fieldKey: key, rawValue: raw, suggestedValue: snap.finalValue });
        setAwaitingConfirmation(true);
        setStage("final_confirm");
        setEditFieldKey(null);
        setMessages((prev) => [...prev, { sender: "bot", text: `Did you mean "${snap.finalValue}" for "${key}"? (yes/no)` }]);
        return;
      }

      if (snap.needsDisambiguation) {
        const item = { kind: "pick_one", fieldKey: key, rawValue: String(raw).trim(), options: snap.options || [] };
        setResponses(responses);
        setPendingQueue([item]);
        setPending(item);
        setAwaitingConfirmation(true);
        setStage("fill_missing");
        setCurrentField(null);
        promptForPending(item);
        return;
      }

      if (snap.needsDisambiguation) {
        const item = { kind: "pick_one", fieldKey: key, rawValue: String(raw).trim(), options: snap.options || [] };
        setPendingQueue([item]);
        setPending(item);
        setAwaitingConfirmation(true);
        setStage("final_confirm");
        setEditFieldKey(null);
        promptForPending(item);
        return;
      }

      if (snap.needsVerify) {
        setPending({ kind: "verify_keep", fieldKey: key, rawValue: String(raw).trim(), suggestions: snap.suggestions || [] });
        setAwaitingConfirmation(true);
        setStage("final_confirm");
        setEditFieldKey(null);
        const sugg = snap.suggestions?.length ? `\nSuggestions: ${snap.suggestions.join(", ")}` : "";
        setMessages((prev) => [
          ...prev,
          { sender: "bot", text: `I couldn't match "${String(raw).trim()}" to known values for "${key}". Keep it as-is? (yes/no)${sugg}` }
        ]);
        return;
      }

      const updated = applyDependencyAutoFill({ ...responses, [key]: snap.finalValue });
      setResponses(updated);

      setStage("final_confirm");
      setEditFieldKey(null);
      setMessages((prev) => [...prev, ...buildSummaryMessages(updated)]);
      setPending({ kind: "final" });
      setAwaitingConfirmation(true);
      return;
    }

    // fallback
    setMessages((prev) => [...prev, { sender: "bot", text: "I got a bit lost — can you rephrase that?" }]);
  };

  
  const commitManualVisitAndContinue = () => {
    const field = String(manualFieldname || "").trim();
    const entry = manualEntry;
    const exit = manualExit;

    if (!field) {
      setMessages((prev) => [...prev, { sender: "bot", text: "Please enter a Field name." }]);
      return;
    }
    if (!entry || !exit) {
      setMessages((prev) => [...prev, { sender: "bot", text: "Please enter both Entry time and Exit time." }]);
      return;
    }

    const entryIso = new Date(entry).toISOString();
    const exitIso = new Date(exit).toISOString();

    if (new Date(exitIso) < new Date(entryIso)) {
      setMessages((prev) => [...prev, { sender: "bot", text: "Exit time must be after Entry time." }]);
      return;
    }

    const autoPrefill = { Entry: entryIso, Exit: exitIso, Fieldname: field };

    if (fieldOrder.some((k) => String(k).toLowerCase().includes("duration"))) {
      const durationMs = new Date(exitIso) - new Date(entryIso);
      const durationMin = Math.round(durationMs / 60000);
      autoPrefill["Duration"] = `${durationMin} minutes`;
    }

    setResponses((prev) => ({ ...prev, ...autoPrefill }));
    setAutoFields((prev) => ({ ...prev, ...autoPrefill }));

    setStage("paragraph");
    setMessages((prev) => [
      ...prev,
      {
        sender: "bot",
        text:
            `Great${userName ? `, ${userName}` : ""}. Tell me what you did in one message (a paragraph is fine). Example:\n` +
            `"I did Planting. My crop was maize, crop rate was 1200 nos./acre, and I used pesticides."`
        }
    ]);
  };

  // -------------------- UI (kept compatible) --------------------

  const inputEnabled = stage !== "done" && stage !== "manual_visit";

  return (
    <div
      style={{
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
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>
        Enterprise Assistant{" "}
        <span style={{ fontWeight: "normal", fontSize: "12px", color: "#666" }}>— {AI_LABEL}</span>
      </div>

      <div style={{ maxHeight: "40vh", overflowY: "auto", marginBottom: "0.5rem" }}>
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: msg.sender === "bot" ? "flex-start" : "flex-end"
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                background: msg.sender === "bot" ? "#f1f1f1" : "#007bff",
                color: msg.sender === "bot" ? "black" : "white",
                padding: "0.5rem",
                borderRadius: "8px",
                margin: "0.25rem 0",
                whiteSpace: "pre-wrap"
              }}
            >
              {msg.text}
            </div>
          </div>
        ))}
        <div ref={chatEndRef}></div>
      </div>

      {stage === "manual_visit" && (
        <div style={{ marginBottom: "0.5rem" }}>
          <input
            type="text"
            value={manualFieldname}
            onChange={(e) => setManualFieldname(e.target.value)}
            placeholder="Field name"
            style={{
              width: "100%",
              padding: "0.5rem",
              marginBottom: "0.5rem",
              fontSize: "16px"
            }}
          />
          <label style={{ fontSize: "14px" }}>Entry time</label>
          <input
            type="datetime-local"
            value={manualEntry}
            onChange={(e) => setManualEntry(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem",
              marginBottom: "0.5rem",
              fontSize: "16px"
            }}
          />
          <label style={{ fontSize: "14px" }}>Exit time</label>
          <input
            type="datetime-local"
            value={manualExit}
            onChange={(e) => setManualExit(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem",
              marginBottom: "0.5rem",
              fontSize: "16px"
            }}
          />
          <button onClick={commitManualVisitAndContinue} style={{ width: "100%", fontSize: "16px" }}>
            Continue
          </button>
        </div>
      )}

      {inputEnabled && (
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
          <button onClick={handleUserInput} style={{ width: "100%", fontSize: "16px" }}>
            Submit
          </button>
        </div>
      )}

      <div style={{ marginTop: "0.5rem" }}>
        <button
          type="button"
          onClick={() => {
            const target = "#map";
            if (window.location.hash === target) {
              window.dispatchEvent(new HashChangeEvent("hashchange"));
            } else {
              window.location.hash = target;
            }
          }}
          style={{
            width: "100%",
            fontSize: "16px",
            padding: "0.5rem",
            background: "#28a745",
            color: "white",
            border: "none",
            borderRadius: "4px"
          }}
        >
          Visualize Operations
        </button>
      </div>
    </div>
  );
};

export default EnterpriseChatbot;
