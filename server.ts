import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "5mb" }));

// Lazy-initialized Gemini client
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is not configured in Settings > Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Helper to decode Gmail base64-encoded strings safely
function decodeBase64(data: string): string {
  if (!data) return "";
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf8");
  } catch (err) {
    console.error("Failed to decode base64 body:", err);
    return "";
  }
}

// Recursive helper to extract text body from Gmail parts
function getBodyText(payload: any): string {
  if (!payload) return "";
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    // Fallback to recursively checking any sub-parts
    for (const part of payload.parts) {
      const text = getBodyText(part);
      if (text) return text;
    }
  }
  return "";
}

// Helper to run Gemini with model fallbacks and exponential backoff retries at module level
async function callGeminiWithFallback(ai: any, contents: string, schema: any, sysInstruction?: string): Promise<any> {
  const modelsToTry = ["gemini-3.5-flash", "gemini-2.5-flash"];
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    let delayMs = 1000;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Calling ${modelName} (Attempt ${attempt}/2)...`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: contents,
          config: {
            systemInstruction: sysInstruction,
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        });
        if (response && response.text) {
          const rawText = response.text.trim();
          try {
            return JSON.parse(rawText);
          } catch (pe) {
            console.warn(`Failed standard JSON parse of response from ${modelName}:`, rawText, pe);
            // Try extracting JSON from inside markdown code blocks (```json ... ```)
            const match = rawText.match(/```json\s*([\s\S]*?)\s*```/);
            if (match && match[1]) {
              return JSON.parse(match[1].trim());
            }
            throw pe;
          }
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`Attempt failed with ${modelName} on attempt ${attempt}:`, err.message || err);
        const errMsg = (err.message || "").toLowerCase();
        const isQuotaExceeded = errMsg.includes("quota") || errMsg.includes("rate limit") || errMsg.includes("429") || errMsg.includes("resource_exhausted") || err.status === 429 || err.code === 429;
        if (isQuotaExceeded) {
          console.warn("Gemini API Quota Exceeded. Bailing out early to fallback to prevent multiple slow/wasteful attempts.");
          throw err;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs *= 2;
        }
      }
    }
  }
  throw lastError || new Error("Failed to contact Gemini servers.");
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Twilio SMS Notification Endpoint (with simulation fallback)
app.post("/api/send-sms-notification", async (req: express.Request, res: express.Response) => {
  try {
    const { body } = req.body;
    if (!body) {
      res.status(400).json({ error: "SMS message body is required." });
      return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNum = process.env.TWILIO_FROM_NUMBER;
    const toNum = process.env.TWILIO_TO_NUMBER;

    if (!accountSid || !authToken || !fromNum || !toNum) {
      console.log(`[SMS SIMULATION] Message: "${body}"`);
      res.json({
        success: true,
        simulated: true,
        message: "Twilio credentials are not fully configured. Notification simulated in UI console.",
        body
      });
      return;
    }

    // Call real Twilio REST API via native fetch!
    const authString = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    const params = new URLSearchParams();
    params.append("From", fromNum);
    params.append("To", toNum);
    params.append("Body", body);

    console.log(`Sending real SMS via Twilio to ${toNum}...`);
    const twilioResponse = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const twilioResult = (await twilioResponse.json()) as any;

    if (!twilioResponse.ok) {
      console.error("Twilio API response error:", twilioResult);
      throw new Error(twilioResult?.message || `Twilio HTTP Error ${twilioResponse.status}`);
    }

    console.log("Real SMS successfully dispatched via Twilio SID:", twilioResult.sid);
    res.json({
      success: true,
      simulated: false,
      sid: twilioResult.sid,
      body
    });
  } catch (err: any) {
    console.error("Failed to send Twilio SMS:", err.message || err);
    res.status(500).json({
      error: `SMS dispatch failed: ${err.message || "Twilio gateway error"}`
    });
  }
});

// Extraction helper for codes
function extractCode(text: string): string | null {
  // Matches GH-12345, IG-123456, or standard 6-digit, 4-digit, or 5-digit PIN
  const sixDigitMatch = text.match(/\b([0-9]{6})\b/);
  if (sixDigitMatch) return sixDigitMatch[1];

  const prefixedMatch = text.match(/\b([a-zA-Z]{2,3}-[0-9]{4,8})\b/);
  if (prefixedMatch) return prefixedMatch[1];

  const generalMatch = text.match(/\b(?:code|pin|otp|passcode|token|verification|mfa|auth)\b.*?(\b[a-zA-Z0-9-]{4,8}\b)/i);
  if (generalMatch && generalMatch[1]) {
    const code = generalMatch[1].replace(/[^a-zA-Z0-9-]/g, "");
    if (code && code.length >= 4 && code.length <= 8) {
      return code;
    }
  }
  return null;
}

// Extraction helper for service names
function extractService(from: string, subject: string): string {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const services = ["github", "netflix", "google", "instagram", "facebook", "chase", "bank", "apple", "amazon", "microsoft", "steam", "uber", "paypal", "slack", "stripe", "discord", "spotify", "zoom"];
  
  for (const service of services) {
    if (fromLower.includes(service) || subjectLower.includes(service)) {
      return service.charAt(0).toUpperCase() + service.slice(1);
    }
  }
  return "Auth Service";
}

// Two-Stage Fast Pass Analyzer (local keywords + regex + custom user rules)
function runFastPassAnalysis(email: any, userRules: any): any | null {
  const subject = (email.subject || "").toLowerCase();
  const body = (email.body || email.snippet || "").toLowerCase();
  const from = (email.from || "").toLowerCase();

  const rules = userRules || { senderWeights: {}, customKeywords: [] };
  const senderWeights = rules.senderWeights || {};
  const customKeywords = rules.customKeywords || [];

  // 1. Resolve based on learned personalization sender rules
  const emailRegex = /<([^>]+)>/;
  const matchEmail = from.match(emailRegex);
  const cleanFromAddress = matchEmail ? matchEmail[1].trim() : from.trim();

  let matchedWeight: string | null = null;
  for (const [key, val] of Object.entries(senderWeights)) {
    const lowerKey = key.toLowerCase();
    if (cleanFromAddress === lowerKey || from.includes(lowerKey)) {
      matchedWeight = val as string;
      break;
    }
  }

  if (matchedWeight === "ALWAYS_URGENT") {
    return {
      id: email.id,
      category: "URGENT",
      summary: `Always urgent sender priority: ${email.subject}`,
      isUrgent: true,
      verificationCode: null,
      verificationService: null,
      suggestedAction: "Respond immediately (Trained Rule)",
      reason: "Trained Sender (Always Urgent)"
    };
  } else if (matchedWeight === "ALWAYS_JUNK") {
    return {
      id: email.id,
      category: "JUNK",
      summary: `Filtered promotional/junk sender: ${email.subject}`,
      isUrgent: false,
      verificationCode: null,
      verificationService: null,
      suggestedAction: "Ignore advertisement (Trained Rule)",
      reason: "Trained Sender (Always Junk)"
    };
  }

  // 2. Resolve based on user custom keyword filters
  for (const kwRule of customKeywords) {
    const kw = (kwRule.keyword || "").toLowerCase();
    if (kw && (subject.includes(kw) || body.includes(kw))) {
      const cat = kwRule.category || "NORMAL";
      const isUrgent = cat === "URGENT" || cat === "AUTH_CODE";
      return {
        id: email.id,
        category: cat,
        summary: `Matched custom keyword "${kw}": ${email.subject}`,
        isUrgent,
        verificationCode: cat === "AUTH_CODE" ? extractCode(subject + " " + body) : null,
        verificationService: cat === "AUTH_CODE" ? extractService(from, subject) : null,
        suggestedAction: cat === "URGENT" ? "Respond immediately" : cat === "AUTH_CODE" ? "Copy verification code" : "Review message",
        reason: `Matched Keyword: ${kw}`
      };
    }
  }

  // 3. Resolve obvious auth codes & OTP patterns (Fast/cheap pass - subjects like "verification code," "OTP," 6-digit patterns)
  const isObviousAuth = 
    subject.includes("verification") || subject.includes("otp") || subject.includes("code") || subject.includes("auth") || subject.includes("pin") || subject.includes("passcode") || subject.includes("mfa") || subject.includes("security") ||
    body.includes("verification") || body.includes("otp") || body.includes("code") || body.includes("auth") || body.includes("pin") || body.includes("passcode") || body.includes("mfa") || body.includes("security") ||
    /\b[0-9]{6}\b/.test(subject) || /\b[0-9]{6}\b/.test(body);

  if (isObviousAuth) {
    const code = extractCode(subject + " " + body);
    if (code) {
      const service = extractService(from, subject);
      return {
        id: email.id,
        category: "AUTH_CODE",
        summary: `${service || "Verification"} login pin is ${code}.`,
        isUrgent: true,
        verificationCode: code,
        verificationService: service || "Auth Service",
        suggestedAction: "Copy verification code",
        reason: "Fast-Pass OTP Detector"
      };
    }
  }

  return null; // Not matching, forward to high-fidelity AI pass
}

// Local Heuristic Fallback (strictly used if Gemini experiences rate-limiting/timeouts)
function runHeuristicAnalysis(emails: any[]): any[] {
  console.log("Using safe local rule-based heuristic fallback analyzer.");
  return emails.map((email) => {
    const subject = (email.subject || "").toLowerCase();
    const body = (email.body || email.snippet || "").toLowerCase();
    const from = (email.from || "").toLowerCase();

    let category = "NORMAL";
    let isUrgent = false;
    let verificationCode: string | null = null;
    let verificationService: string | null = null;
    let suggestedAction = "View message details";

    const code = extractCode(subject + " " + body);
    if (code) {
      category = "AUTH_CODE";
      isUrgent = true;
      verificationCode = code;
      verificationService = extractService(from, subject);
      suggestedAction = "Copy verification code";
    } else if (
      subject.includes("urgent") || subject.includes("important") || subject.includes("critical") ||
      subject.includes("action required") || subject.includes("delayed") || body.includes("asap") ||
      body.includes("immediately") || body.includes("deadline")
    ) {
      category = "URGENT";
      isUrgent = true;
      suggestedAction = "Review and respond immediately";
    } else if (
      subject.includes("deal") || subject.includes("sale") || subject.includes("promo") ||
      body.includes("unsubscribe") || body.includes("opt out") || from.includes("marketing") ||
      from.includes("newsletter")
    ) {
      category = "JUNK";
      suggestedAction = "Ignore advertisement";
    }

    let summary = email.subject || "No subject email";
    if (email.snippet) {
      const cleanSnippet = email.snippet.replace(/[\r\n]+/g, " ").trim();
      summary = `${cleanSnippet.substring(0, 100)}...`;
    }

    return {
      ...email,
      category,
      summary,
      isUrgent,
      verificationCode,
      verificationService,
      suggestedAction,
      reason: "Local Fallback Rules"
    };
  });
}

// Primary Endpoint: Fetch and Analyze emails using Two-Stage Classification
app.post("/api/analyze-emails", async (req: express.Request, res: express.Response) => {
  try {
    const { accessToken, sandbox, sandboxEmails, userRules } = req.body;

    let emailsToAnalyze: any[] = [];

    if (sandbox) {
      emailsToAnalyze = sandboxEmails || [];
    } else {
      if (!accessToken) {
        res.status(401).json({ error: "Gmail access token is missing. Please sign in." });
        return;
      }

      // 1. Fetch latest 15 message headers from Gmail
      const listResponse = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!listResponse.ok) {
        const errText = await listResponse.text();
        throw new Error(`Gmail API List Error: ${listResponse.statusText} (${errText})`);
      }

      const listData = (await listResponse.json()) as { messages?: { id: string }[] };
      const messages = listData.messages || [];

      if (messages.length === 0) {
        res.json({ emails: [], fastPassCount: 0, aiCount: 0 });
        return;
      }

      // 2. Fetch full content for each email in parallel
      const detailPromises = messages.map(async (msg) => {
        const detailResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!detailResponse.ok) return null;
        return detailResponse.json();
      });

      const details = await Promise.all(detailPromises);

      // 3. Parse headers and bodies
      emailsToAnalyze = details
        .filter((d) => d !== null)
        .map((email: any) => {
          const headers = email.payload?.headers || [];
          const subject = headers.find((h: any) => h.name.toLowerCase() === "subject")?.value || "(No Subject)";
          const from = headers.find((h: any) => h.name.toLowerCase() === "from")?.value || "Unknown Sender";
          const date = headers.find((h: any) => h.name.toLowerCase() === "date")?.value || "";
          const body = getBodyText(email.payload) || email.snippet || "";

          return {
            id: email.id,
            from,
            subject,
            date,
            snippet: email.snippet || "",
            body: body.substring(0, 1500),
          };
        });
    }

    if (emailsToAnalyze.length === 0) {
      res.json({ emails: [], fastPassCount: 0, aiCount: 0 });
      return;
    }

    // 4. Two-Stage Splitter: Match Fast Pass (local rules + regex) vs AI LLM Queue or Cached/Existing Analysis
    const fastPassResults: any[] = [];
    const llmQueue: any[] = [];
    const cachedResults: any[] = [];

    // Find if we have existing analyzed emails passed from the client
    const existingList = sandboxEmails || [];

    for (const email of emailsToAnalyze) {
      // Stage 1: Fast Pass
      const fastHit = runFastPassAnalysis(email, userRules);
      if (fastHit) {
        fastPassResults.push({
          ...email,
          ...fastHit,
          isFastPass: true
        });
      } else {
        // Check if we already have this email analyzed in our existing list
        const existing = existingList.find(
          (e: any) => e.id === email.id && e.category && e.summary
        );
        if (existing) {
          cachedResults.push({
            ...email,
            category: existing.category,
            summary: existing.summary,
            isUrgent: existing.isUrgent,
            verificationCode: existing.verificationCode,
            verificationService: existing.verificationService,
            suggestedAction: existing.suggestedAction,
            isFastPass: existing.isFastPass ?? false,
            reason: existing.reason || "Reused Analysis"
          });
        } else {
          llmQueue.push(email);
        }
      }
    }

    let enrichedEmails: any[] = [];
    let isFallback = false;

    // Call Gemini ONLY for the emails not classified by the fast-pass or found in cache
    if (llmQueue.length > 0) {
      try {
        const ai = getGeminiClient();
        const prompt = `You are an elite Email Virtual Assistant. Analyze these ${llmQueue.length} emails and classify them.
Categorize each email into exactly one of these categories:
- 'URGENT': Critically important, actionable, or time-sensitive emails (e.g., flight status, urgent work requests, scheduled meetings).
- 'AUTH_CODE': Verification codes, security alerts, login pins, MFA tokens, OTPs, or password reset confirmations.
- 'NORMAL': General updates, newsletters, personal conversations, non-urgent transactions.
- 'JUNK': Pure advertisements, spam, marketing blasts, or unsolicited junk mail.

For each email, extract or determine:
1. One-sentence summary explaining the key update/action.
2. A boolean 'isUrgent' (true if the email needs attention in the next 12 hours).
3. The exact 'verificationCode' if an 'AUTH_CODE' email (e.g., "758210"). Otherwise null.
4. The 'verificationService' name (e.g., "Netflix") if an 'AUTH_CODE' email. Otherwise null.
5. A brief 'suggestedAction' (e.g., "Copy authorization code", "Respond to sender", "Ignore advertisement").

Here is the structured list of emails to analyze:
${JSON.stringify(llmQueue, null, 2)}`;

        const responseSchema = {
          type: Type.OBJECT,
          properties: {
            emails: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "The original email ID" },
                  category: { type: Type.STRING, description: "URGENT, AUTH_CODE, NORMAL, or JUNK" },
                  summary: { type: Type.STRING, description: "A one-sentence summary of the message contents" },
                  isUrgent: { type: Type.BOOLEAN, description: "Whether the email is highly urgent" },
                  verificationCode: { type: Type.STRING, description: "The authorization/verification code if present, otherwise null" },
                  verificationService: { type: Type.STRING, description: "The brand/company requesting authorization, otherwise null" },
                  suggestedAction: { type: Type.STRING, description: "A recommended response/action to take" },
                },
                required: ["id", "category", "summary", "isUrgent"],
              },
            },
          },
          required: ["emails"],
        };

        const parsedOutput = await callGeminiWithFallback(
          ai,
          prompt,
          responseSchema,
          "Format the output exactly as JSON according to the requested schema. Ensure all fields are filled accurately."
        );

        const llmResults = llmQueue.map((original) => {
          const analysis = parsedOutput.emails?.find((e: any) => e.id === original.id) || {
            category: "NORMAL",
            summary: original.snippet || "Standard email message.",
            isUrgent: false,
            verificationCode: null,
            verificationService: null,
            suggestedAction: "View details",
          };

          return {
            ...original,
            ...analysis,
            isFastPass: false,
            reason: "High-Fidelity Gemini Pass"
          };
        });

        // Merge back together
        enrichedEmails = emailsToAnalyze.map((original) => {
          const fast = fastPassResults.find((e) => e.id === original.id);
          if (fast) return fast;
          const cached = cachedResults.find((e) => e.id === original.id);
          if (cached) return cached;
          return llmResults.find((e) => e.id === original.id) || {
            ...original,
            category: "NORMAL",
            summary: original.snippet || "Standard email message.",
            isUrgent: false,
            verificationCode: null,
            verificationService: null,
            suggestedAction: "View details",
            isFastPass: false,
            reason: "AI Pass Defaulter"
          };
        });

      } catch (err: any) {
        console.warn("Gemini call completely failed. Resorting to fallback:", err.message || err);
        // Fallback local analysis for the queued portion
        const fallbackResults = runHeuristicAnalysis(llmQueue);
        enrichedEmails = emailsToAnalyze.map((original) => {
          const fast = fastPassResults.find((e) => e.id === original.id);
          if (fast) return fast;
          const cached = cachedResults.find((e) => e.id === original.id);
          if (cached) return cached;
          return fallbackResults.find((e) => e.id === original.id) || {
            ...original,
            category: "NORMAL",
            summary: original.snippet || "Standard email message.",
            isUrgent: false,
            verificationCode: null,
            verificationService: null,
            suggestedAction: "View details",
            isFastPass: false,
            reason: "Fallback Defaulter"
          };
        });
        isFallback = true;
      }
    } else {
      // All emails resolved near-instantly by fast-pass or caching! No LLM call was required!
      enrichedEmails = emailsToAnalyze.map((original) => {
        const fast = fastPassResults.find((e) => e.id === original.id);
        if (fast) return fast;
        const cached = cachedResults.find((e) => e.id === original.id);
        if (cached) return cached;
        return {
          ...original,
          category: "NORMAL",
          summary: original.snippet || "Standard email message.",
          isUrgent: false,
          verificationCode: null,
          verificationService: null,
          suggestedAction: "View details",
          isFastPass: false,
          reason: "Unknown State Defaulter"
        };
      });
    }

    res.json({
      emails: enrichedEmails,
      isFallback,
      fastPassCount: fastPassResults.length,
      aiCount: emailsToAnalyze.length - fastPassResults.length
    });
  } catch (error: any) {
    console.error("Analyze Email Error:", error);
    res.status(500).json({
      error: error?.message || "An internal error occurred during email analysis.",
    });
  }
});

// Single email dynamic analysis endpoint (with Two-Stage logic integration)
app.post("/api/analyze-single", async (req: express.Request, res: express.Response) => {
  try {
    const { from, subject, body, userRules } = req.body;
    if (!from || !subject || !body) {
      res.status(400).json({ error: "From, Subject, and Body are all required." });
      return;
    }

    const mockEmail = {
      id: "single-temp",
      from,
      subject,
      body,
      snippet: body.substring(0, 100)
    };

    // Stage 1 Check
    const fastHit = runFastPassAnalysis(mockEmail, userRules);
    if (fastHit) {
      res.json({
        ...fastHit,
        isFastPass: true,
        isFallback: false
      });
      return;
    }

    // Stage 2 Check (Gemini)
    let parsed = null;
    let isFallback = false;
    try {
      const ai = getGeminiClient();
      const prompt = `Analyze this email and categorize it as 'URGENT', 'AUTH_CODE', 'NORMAL', or 'JUNK'.
Extract verification code, requesting service, and provide a 1-sentence summary and suggested action.
Sender: ${from}
Subject: ${subject}
Body: ${body}`;

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          summary: { type: Type.STRING },
          isUrgent: { type: Type.BOOLEAN },
          verificationCode: { type: Type.STRING },
          verificationService: { type: Type.STRING },
          suggestedAction: { type: Type.STRING },
        },
        required: ["category", "summary", "isUrgent", "suggestedAction"],
      };

      parsed = await callGeminiWithFallback(ai, prompt, responseSchema);
    } catch (err) {
      console.warn("Single analysis failed. Running heuristic fallback:", err);
      isFallback = true;
      
      const heuristicResults = runHeuristicAnalysis([mockEmail]);
      const singleFallback = heuristicResults[0];

      parsed = {
        category: singleFallback.category,
        summary: singleFallback.summary,
        isUrgent: singleFallback.isUrgent,
        verificationCode: singleFallback.verificationCode,
        verificationService: singleFallback.verificationService,
        suggestedAction: singleFallback.suggestedAction,
      };
    }

    res.json({
      ...parsed,
      isFastPass: false,
      isFallback
    });
  } catch (error: any) {
    console.error("Single email analysis error:", error);
    res.status(500).json({ error: error?.message || "Failed to analyze single email." });
  }
});

// Serve frontend assets and listen
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Email Assistant server is active on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Server boot failure:", err);
});
