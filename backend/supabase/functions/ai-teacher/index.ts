// ============================================================================
// StudyHub — AI Teacher Edge Function (OpenRouter)
//
// Deploy with:   supabase functions deploy ai-teacher
// Requires a secret, set once with:
//   supabase secrets set OPENROUTER_API_KEY=sk-or-v1-your-real-key
//
// Get a free key at https://openrouter.ai/keys (no credit card needed).
// The frontend (js/ai-teacher.js) never sees this key — it calls this
// function with the user's Supabase session token, and this function is the
// only place that talks to OpenRouter.
//
// Uses "openrouter/free" — OpenRouter's free-models router. It automatically
// picks a $0/token model that supports whatever the request needs (including
// image understanding), so this doesn't break when any one free model gets
// rotated out. Free tier is rate-limited (~20 req/min, 50-1000 req/day
// depending on your account) — plenty for a student project, but if
// StudyHub grows, swap MODEL below for a specific paid model.
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MODEL = "openrouter/free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const SYSTEM_PROMPT = `You are "AI Teacher", the study assistant built into StudyHub, an educational
platform for school and college students. You help students understand concepts and solve
academic problems across all subjects (math, physics, chemistry, biology, computer science,
languages, and more).

Guidelines:
- When a student uploads a photo of a question, read it carefully and solve it step by step.
- Explain your reasoning, don't just give a final answer — the goal is understanding, not
  just homework completion.
- Keep answers clear and appropriately levelled for a school/college student.
- If a question is ambiguous or the image is unclear, ask a brief clarifying question.
- Be encouraging and patient, like a good tutor.
- Stay focused on educational help. For anything outside that (and clearly harmful requests),
  politely redirect back to studying.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!OPENROUTER_API_KEY) {
    return json(
      { error: "AI Teacher isn't configured yet. Ask the site admin to set the OPENROUTER_API_KEY secret." },
      503
    );
  }

  try {
    // Verify the caller is a real, logged-in StudyHub user before spending API quota.
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { message, imageBase64, imageMediaType, history } = await req.json();

    if (!message?.trim() && !imageBase64) {
      return json({ error: "Send a message or an image." }, 400);
    }

    // OpenRouter speaks the OpenAI chat-completions format.
    const userContent: Record<string, unknown>[] = [
      { type: "text", text: message?.trim() || "Please help me with this question." },
    ];
    if (imageBase64) {
      userContent.unshift({
        type: "image_url",
        image_url: { url: `data:${imageMediaType || "image/jpeg"};base64,${imageBase64}` },
      });
    }

    const priorMessages = Array.isArray(history)
      ? history.slice(-8).map((m: { role: string; content: string }) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || "").slice(0, 4000),
        }))
      : [];

    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...priorMessages, { role: "user", content: userContent }];

    const openRouterRes = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        // OpenRouter asks for these to attribute traffic — put your real site details here.
        "HTTP-Referer": "https://studyhub.example",
        "X-Title": "StudyHub AI Teacher",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 1400,
      }),
    });

    if (!openRouterRes.ok) {
      const errText = await openRouterRes.text();
      console.error("OpenRouter API error:", openRouterRes.status, errText);
      return json({ error: "AI Teacher couldn't respond just now. Please try again." }, 502);
    }

    const data = await openRouterRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "";

    return json({ reply: reply || "I couldn't come up with a response — try rephrasing your question." });
  } catch (err) {
    console.error("ai-teacher function error:", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
