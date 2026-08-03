import { NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/api-helpers";
import { rateLimit, requestKey } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Schema for the AI-parsed receipt response
// ---------------------------------------------------------------------------
const parsedReceiptSchema = z.object({
  /** Vendor/business name printed on the receipt (or customer name if it's a bill). */
  clientName: z.string().min(1, "clientName is required").max(200),
  /** Line items extracted from the receipt. */
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        quantity: z.number().int().min(1),
        price: z.number().min(0),
      })
    )
    .min(1, "At least one line item is required"),
});

export type ParsedReceipt = z.infer<typeof parsedReceiptSchema>;

// ---------------------------------------------------------------------------
// Request body schema
// ---------------------------------------------------------------------------
const requestSchema = z.object({
  /** Base64-encoded image data (with or without the data:image prefix). */
  image: z.string().min(1, "image is required"),
});

// Initialize OpenAI lazily — we do this inside the handler (not at module scope)
// so that missing API keys don't crash the build process. The key is validated
// at request time and a clear 503 is returned if absent.
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * POST /api/parse-receipt
 *
 * Accepts a base64-encoded receipt image and uses GPT-4o-mini (vision) to
 * extract the vendor name and line items. Returns a strict JSON payload:
 *
 *   { clientName: string, items: [{ description, quantity, price }] }
 *
 * Request body: { image: "data:image/jpeg;base64,...." } or raw base64.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    // Rate limit per user (5 uploads per minute) to prevent burning OpenAI credits.
    const rl = rateLimit(requestKey(request, user.id), {
      namespace: "parse-receipt",
      limit: 5,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many receipt uploads — please wait a minute and try again." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        }
      );
    }

    // 1. Parse and validate the incoming request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 }
      );
    }

    // Normalize base64 (strip data URL prefix if present so we can re-add
    // a consistent data URL for the Vision API).
    let imageBase64 = parsed.data.image.trim();
    if (imageBase64.startsWith("data:")) {
      // Already a data URL — pass through as-is
    } else {
      // Assume JPEG if no prefix (most common receipt upload format)
      imageBase64 = `data:image/jpeg;base64,${imageBase64}`;
    }

    // 3. Call GPT-4o-mini with vision enabled
    const openai = getOpenAIClient();
    if (!openai) {
      return NextResponse.json(
        { error: "OpenAI API key is not configured. Set OPENAI_API_KEY." },
        { status: 503 }
      );
    }

    const systemPrompt = `You are a precise receipt/bill parser. Look at the provided image and extract the following information as STRICT JSON matching this TypeScript type:

type ParsedReceipt = {
  clientName: string;        // The vendor/merchant/business name on the receipt (e.g., "Starbucks", "Amazon", "Acme Corp"). If you see a "BILLED TO" or customer name instead of vendor, use the customer/business name provided.
  items: Array<{
    description: string;     // Short product/service description (max ~80 chars, trim verbose text)
    quantity: number;        // Whole number >= 1 (default to 1 if not listed)
    price: number;           // Unit price in the receipt's currency as a non-negative number (no currency symbols)
  }>;
};

Rules:
- Return ONLY a valid JSON object. No markdown, no explanation, no commentary.
- Do not wrap in \`\`\`json ... \`\`\` — output raw JSON.
- Extract every visible line item you can. Do not sum or add tax lines as items — just purchased products/services.
- If you cannot read the image at all, return { "clientName": "Unknown Merchant", "items": [] } — never throw or return an error.
- Convert amounts to decimal numbers (e.g., 12.50 not "$12.50").
- All text should be in English; transliterate if needed.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Parse this receipt image and return ONLY the JSON object as specified:",
            },
            {
              type: "image_url",
              image_url: {
                url: imageBase64,
                detail: "high",
              },
            },
          ],
        },
      ],
      temperature: 0.1, // Low temperature → more deterministic extraction
      max_tokens: 1500,
      response_format: { type: "json_object" }, // Enforce JSON mode (OpenAI-supported)
    });

    const rawContent = completion.choices[0]?.message?.content?.trim() ?? "{}";

    // 4. Parse & validate AI output against our schema
    let aiData: unknown;
    try {
      aiData = JSON.parse(rawContent);
    } catch {
      console.error("[parse-receipt] AI returned non-JSON response");
      return NextResponse.json(
        { error: "AI returned an invalid response. Please try again or a clearer image." },
        { status: 502 }
      );
    }

    const validated = parsedReceiptSchema.safeParse(aiData);
    if (!validated.success) {
      console.error("[parse-receipt] AI response failed schema validation");
      return NextResponse.json(
        {
          error: "Could not reliably parse the receipt. Please try a clearer image.",
        },
        { status: 422 }
      );
    }

    // 5. Return the parsed receipt data
    return NextResponse.json(validated.data, { status: 200 });
  } catch (error) {
    console.error("[POST /api/parse-receipt] Failed:", error);

    // OpenAI-specific error handling (auth, rate limits, etc.)
    if (error instanceof Error && "status" in error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        return NextResponse.json(
          { error: "Invalid OpenAI API key" },
          { status: 503 }
        );
      }
      if (status === 429) {
        return NextResponse.json(
          { error: "OpenAI rate limit reached. Please try again in a moment." },
          { status: 429 }
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to parse receipt" },
      { status: 500 }
    );
  }
}
