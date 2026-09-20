// Shared vision fallback — Deep's family calorie tracker (2026-09-17).
//
// Why this exists: Ollama (home/Tailscale) and the on-device WebGPU model (device-dependent,
// confirmed NOT available on Deep's own phone) both have real gaps. This is the third leg —
// a single Gemini API key, held ONLY here, server-side, never distributed to any device. Every
// family member's app calls this function; none of them ever sees or needs a key of their own.
//
// Text mode added 2026-09-20 — real production bug found: `VITE_OLLAMA_TAILSCALE_URL` was never
// wired into the GitHub Actions build secrets, so every deployed user's Ollama candidate list was
// just `localhost:11434` (their own device — never Deep's). The photo path already had a real
// Ollama -> Gemini -> on-device cascade (see App.tsx's handleCapture); the voice/text path
// (VoiceCapture.tsx) only ever tried Ollama and hard-failed with "All Ollama endpoints failed" —
// text/voice meal logging was broken for every real user in production. Body now accepts EITHER
// `{imageBase64, mimeType}` (existing photo path, unchanged) OR `{conversation}` (new text path,
// same ConversationTurn[]/clarify-or-items contract as ollamaVision.ts's parseFoodTextViaOllama).
//
// Auth: relies on Supabase's default `verify_jwt` behavior for Edge Functions (no config.toml
// override here) — only requests carrying a valid Supabase session JWT reach this code, which
// every real user of the app already has via ensureAuthenticated()'s anonymous sign-in. This is
// NOT a public-internet-facing endpoint; it can't be hit by a stranger to drain the Gemini quota.
//
// Model: `gemini-flash-lite-latest`, not `gemini-flash-latest` — changed 2026-09-17 after real
// live testing (Deep's own key, 3 back-to-back calls each) showed flash-latest returning genuine
// 503 "high demand" twice, while flash-lite-latest answered instantly and correctly every time.
// This is a reliability call, not a guess: for a simple "what food is this" vision task, the lite
// tier's accuracy is more than enough, and for a shared family app, "answers reliably" beats
// "slightly better food-name guesses" every time.
//
// Real bug found and fixed the same session: the original prompt asked for JSON "with no
// markdown", but on a photo with 5+ real items (tested: eggs + stir-fry + noodles), the response
// ran long enough to hit maxOutputTokens BEFORE the closing brace — confirmed via the exact error
// text this produced (`No parseable JSON in Gemini response: {"items":`, cut off mid-object).
// Fixed at the actual cause: `responseMimeType: "application/json"` (verified against the real
// API directly, not the model card — a docs fetch claimed a different, wrong field name first)
// forces clean JSON with no prose/markdown overhead, and maxOutputTokens raised to give real
// multi-item photos headroom to finish.
//
// Contract: same IdentifiedItem[] shape (`{name, estimated_grams}`) as ollamaVision.ts's
// PROMPT/response format and onDeviceVision.ts — resolveFoodItems.ts downstream doesn't know or
// care which of the three vision paths produced its input.

const GEMINI_MODEL = "gemini-flash-lite-latest";

const VISION_PROMPT =
  "Identify the distinct food items visible in this photo. List each DISTINCT item only ONCE. " +
  "Maximum 6 items total. Respond ONLY with valid JSON, no markdown, no commentary, in this exact " +
  'shape: {"items":[{"name":"string","estimated_grams":number}]}. Use short, generic food names ' +
  'suitable for a nutrition database lookup (e.g. "grilled chicken breast", not "delicious juicy ' +
  "chicken\"). Estimate a realistic portion size in grams for each item based on what is visible. " +
  "If the image shows no real food, respond with {\"items\":[]}.";

// Same contract as ollamaVision.ts's TEXT_PARSE_SYSTEM_PROMPT — kept in sync deliberately so
// switching providers never changes what the user experiences.
const TEXT_SYSTEM_PROMPT =
  "You are a nutrition-logging assistant. The user describes food they ate in natural language, " +
  "possibly transcribed from speech so it may contain minor transcription errors. Convert their " +
  "description into a food item list for a nutrition database lookup.\n\n" +
  "Respond ONLY with valid JSON, no markdown, no commentary, in exactly one of these two shapes:\n" +
  '1. If you can confidently identify every food item and a reasonable portion size: ' +
  '{"type":"items","items":[{"name":"string","estimated_grams":number}]}\n' +
  '2. If any part is genuinely ambiguous (unclear quantity, unclear food identity, a vague amount ' +
  'like "some" or "a bit" with no sensible default, or multiple plausible interpretations) and asking ' +
  'would meaningfully improve accuracy: {"type":"clarify","question":"a short, specific, single ' +
  'follow-up question a person could answer in one short sentence"}\n\n' +
  'Rules: prefer "items" over "clarify" whenever a reasonable default estimate is possible — do not ' +
  'ask about things you can estimate sensibly (e.g. "a coffee" -> assume a 240ml black coffee unless ' +
  'told otherwise). Only ask ONE question at a time, about the single most important ambiguity. Use ' +
  'short, generic food names suitable for a nutrition database lookup (e.g. "scrambled eggs", not ' +
  '"delicious fluffy eggs"). Maximum 8 items total. Never fabricate detail the user did not say or imply.';

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/** Shared by both the photo and text paths — Gemini returns a genuine 503 "high demand" often
 * enough that a bare single attempt isn't good enough for a family app; this is Google's own
 * server load, not our request, so a short retry is the correct fix. 429 gets the same treatment. */
async function callGeminiWithRetry(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ res: Response | null; lastDetail: string }> {
  let res: Response | null = null;
  let lastDetail = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      },
    );
    if (res.ok) break;
    if (res.status !== 503 && res.status !== 429) break;
    lastDetail = await res.text();
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return { res, lastDetail };
}

function extractJson(rawText: string | undefined): unknown {
  if (!rawText) throw new Error("Gemini returned no text content");
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No parseable JSON in Gemini response: ${rawText.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return jsonResponse({ error: "GEMINI_API_KEY is not configured on the server" }, 500);
    }

    // Text path (2026-09-20) — voice/typed meal description, no image. Checked first since a
    // `conversation` array is the more specific/unambiguous signal.
    if (Array.isArray(body?.conversation)) {
      const conversation = body.conversation as ConversationTurn[];
      if (conversation.length === 0 || conversation.some((t) => typeof t?.content !== "string")) {
        return jsonResponse({ error: "conversation must be a non-empty array of {role, content}" }, 400);
      }
      const { res: geminiRes, lastDetail } = await callGeminiWithRetry(apiKey, {
        systemInstruction: { parts: [{ text: TEXT_SYSTEM_PROMPT }] },
        contents: conversation.map((t) => ({
          role: t.role === "assistant" ? "model" : "user",
          parts: [{ text: t.content }],
        })),
        generationConfig: { temperature: 0.2, maxOutputTokens: 512, responseMimeType: "application/json" },
      });
      if (!geminiRes) return jsonResponse({ error: "Gemini API call never completed" }, 502);
      if (!geminiRes.ok) {
        const detail = geminiRes.status === 503 || geminiRes.status === 429 ? lastDetail : await geminiRes.text();
        return jsonResponse({ error: `Gemini API error (${geminiRes.status}) after retries: ${detail.slice(0, 300)}` }, 502);
      }
      const geminiJson = await geminiRes.json();
      const parsed = extractJson(geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text) as {
        type?: string;
        question?: string;
        items?: Array<{ name: string; estimated_grams: number }>;
      };
      if (parsed.type === "clarify" && typeof parsed.question === "string" && parsed.question.trim()) {
        return jsonResponse({ type: "clarify", question: parsed.question.trim() }, 200);
      }
      if (parsed.type === "items" && Array.isArray(parsed.items)) {
        return jsonResponse({ type: "items", items: parsed.items }, 200);
      }
      return jsonResponse({ error: "Unparseable response shape from Gemini text path" }, 502);
    }

    // Photo path (existing, unchanged behavior).
    const { imageBase64, mimeType } = body;
    if (typeof imageBase64 !== "string" || typeof mimeType !== "string") {
      return jsonResponse({ error: "imageBase64 and mimeType are required" }, 400);
    }
    const { res: geminiRes, lastDetail } = await callGeminiWithRetry(apiKey, {
      contents: [
        { role: "user", parts: [{ text: VISION_PROMPT }, { inlineData: { mimeType, data: imageBase64 } }] },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: "application/json" },
    });
    if (!geminiRes) {
      return jsonResponse({ error: "Gemini API call never completed" }, 502);
    }
    if (!geminiRes.ok) {
      const detail = geminiRes.status === 503 || geminiRes.status === 429 ? lastDetail : await geminiRes.text();
      return jsonResponse({ error: `Gemini API error (${geminiRes.status}) after retries: ${detail.slice(0, 300)}` }, 502);
    }
    const geminiJson = await geminiRes.json();
    const parsed = extractJson(geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text) as {
      items?: Array<{ name: string; estimated_grams: number }>;
    };
    return jsonResponse({ items: parsed.items ?? [] }, 200);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
