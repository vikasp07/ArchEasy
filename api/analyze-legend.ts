/**
 * Legend Mapping: reads ONE discipline drawing (furniture, ceiling, flooring or
 * wall finishes), transcribes its legend, and says which legend item applies to
 * each labelled room. The client calls this once per sheet, independently, and
 * merges the four results into one Schedule of Finishes.
 *
 * Server-only, like analyze-drawing: GEMINI_API_KEY never reaches the browser,
 * and every call requires a signed-in Supabase user.
 */
import {
  requireUser,
  respondGeminiError,
  extractText,
  parseAiJson,
  callGemini,
  heavyCallTimeoutMs,
  type ApiRequest,
  type ApiResponse,
  type GeminiResult,
} from "./_shared.js";

export type LegendSheetKind = "furniture" | "ceiling" | "flooring" | "wall";

const SHEET_KINDS: LegendSheetKind[] = ["furniture", "ceiling", "flooring", "wall"];

/** What each sheet type's legend describes, and which fields matter. */
const KIND_GUIDE: Record<LegendSheetKind, string> = {
  furniture: `This is a FURNITURE LAYOUT plan. Its job in the Schedule of Finishes is the ROOM LIST.
- Every labelled space is a room: transcribe all of them, including small service spaces (AHU, UPS, BATT, DB, shafts, stores, lockers, ramps, lobbies, passages, balconies).
- The legend / schedule table (if any) lists furniture or equipment items. Treat each item as a legend entry.
- For each room, "requirements" = the furniture / fixtures shown in it and the seat count (e.g. "6-seater meeting table, 6 chairs, LCD panel"). "legend_keys" = keys of legend items used in that room.
- Leave material fields empty unless the sheet actually states a finish.`,
  ceiling: `This is a REFLECTED CEILING PLAN. Its legend maps hatch patterns / colours to CEILING finishes (e.g. gypsum board, grid/lay-in tiles, metal baffle, open ceiling with paint, wooden/acoustic panels) and often ceiling heights.
- For each room, decide which legend hatch/colour fills that room's ceiling.
- "material" = primary ceiling finish, "material_2" = secondary finish/paint if a second legend item or a paint note also applies, "size" = tile/panel module if stated (e.g. "600 x 600"), "height" = ceiling height if stated.
- Ignore the section drawings (SECTION AA/BB/CC) except to read ceiling heights.`,
  flooring: `This is a FLOORING PLAN. Its legend maps hatch patterns to FLOOR finishes (e.g. vitrified tiles, carpet tiles, wooden flooring, granite, kota stone, anti-skid tiles, vinyl, existing flooring).
- For each room, decide which legend hatch fills that room's floor.
- "material" = flooring material, "size" = tile size if stated (e.g. "600 x 600", "1200 x 600"), "finish" = surface finish if stated (matt, glossy, anti-skid, honed...), "code" = legend code/tag (e.g. "FL-01", "VT-02"), "make" = brand if stated.
- "skirting" = skirting material if the legend or notes specify it for that floor finish.`,
  wall: `This is a WALL FINISHES plan. Its legend maps LINE colours / line types drawn along walls to WALL finishes (e.g. paint, wallpaper, wall tiles, wooden panelling, fabric panels, glass, acoustic panels, whiteboard paint).
- For each room, list the legend items drawn on that room's walls.
- "material" = the main wall finish, "material_2" = paint colour / shade or the second wall finish if present, "dado" = dado / tiling height if a tile or dado finish applies.
- A room may use several wall legend items; include every key in "legend_keys".`,
};

const SYSTEM_PROMPT = `You are a senior interior architect reading construction drawings to prepare a Schedule of Finishes.

You will receive ONE drawing sheet plus its type. Work in three steps:

STEP 1 - LEGEND
Find the sheet's legend / key / schedule box (usually in the title block or a corner). Transcribe EVERY legend entry:
- "key": a short unique id. Use the drawing's own code if it has one (e.g. "FL-01"), otherwise "L1", "L2"... in legend order.
- "symbol": what the entry looks like (e.g. "pink cross-hatch", "dashed green line", "diagonal 45 deg hatch").
- "color_hex": the swatch colour as a hex string if the entry is a colour (e.g. "#e83e8c"); empty string for black-and-white hatches.
- "material", "specification" (full description as written), "code", "size", "finish", "make" when stated. Empty strings otherwise.
If the legend text is too small to read, still list the entry with what you can see and say so in "specification".

STEP 2 - ROOMS
Transcribe every labelled space on the plan. Rules:
- Keep the drawing's own wording (e.g. "6P MR", "AHU ROOM", "GENT'S TOILET"). Never merge repeated labels: three "6P MR" labels are three rooms.
- "space_tag": a room number/code if shown, else empty.
- "bbox": normalised integers [ymin, xmin, ymax, xmax] on a 0-1000 scale covering the room ON THIS SHEET. Required.
- "legend_keys": the legend keys that apply to this room on this sheet (empty array if none).
- Fill the material fields from the legend entry that applies, as described in the sheet guide below.
- "requirements": the room's specific requirement on this sheet in one short sentence (what goes there and why it matters, e.g. moisture, slip, acoustics, durability).

STEP 3 - CHECK
- Every legend entry should be used by at least one room, or be listed in "unmatched_legend_keys".
- Rooms whose finish you could not determine go in "uncertain_rooms" with a reason.

Return raw JSON only. No markdown, no commentary.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    legend: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          symbol: { type: "string" },
          color_hex: { type: "string" },
          material: { type: "string" },
          specification: { type: "string" },
          code: { type: "string" },
          size: { type: "string" },
          finish: { type: "string" },
          make: { type: "string" },
        },
        required: ["key", "symbol", "material", "specification"],
        propertyOrdering: ["key", "symbol", "color_hex", "material", "specification", "code", "size", "finish", "make"],
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          space_tag: { type: "string" },
          bbox: { type: "array", items: { type: "integer" } },
          legend_keys: { type: "array", items: { type: "string" } },
          material: { type: "string" },
          material_2: { type: "string" },
          size: { type: "string" },
          finish: { type: "string" },
          code: { type: "string" },
          make: { type: "string" },
          skirting: { type: "string" },
          dado: { type: "string" },
          height: { type: "string" },
          requirements: { type: "string" },
        },
        required: ["name", "bbox", "legend_keys", "material", "requirements"],
        propertyOrdering: [
          "name", "space_tag", "bbox", "legend_keys", "material", "material_2", "size",
          "finish", "code", "make", "skirting", "dado", "height", "requirements",
        ],
      },
    },
    unmatched_legend_keys: { type: "array", items: { type: "string" } },
    uncertain_rooms: { type: "array", items: { type: "string" } },
  },
  required: ["legend", "rooms", "summary"],
  propertyOrdering: ["summary", "legend", "rooms", "unmatched_legend_keys", "uncertain_rooms"],
};

interface LegendBody {
  imageBase64?: string;
  fileName?: string;
  mimeType?: string;
  floorName?: string;
  kind?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const strArray = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** Accepts only a well-formed [ymin, xmin, ymax, xmax] on 0-1000; anything else becomes null. */
function cleanBox(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map((x) => Math.max(0, Math.min(1000, Math.round(Number(x)))));
  if (n.some((x) => !Number.isFinite(x)) || n[2] <= n[0] || n[3] <= n[1]) return null;
  return n;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server" });
    }

    const body: LegendBody =
      typeof req.body === "string" ? JSON.parse(req.body) : ((req.body ?? {}) as LegendBody);
    const { imageBase64, fileName, mimeType, floorName } = body;
    const kind = SHEET_KINDS.find((k) => k === body.kind);

    if (!kind) {
      return res.status(400).json({ error: `kind must be one of: ${SHEET_KINDS.join(", ")}` });
    }
    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    const match = /^data:([^;]+);base64,(.*)$/s.exec(imageBase64);
    const inlineMimeType = match?.[1] || mimeType || "image/png";
    const base64Data = match?.[2] || imageBase64;
    const floorLabel = typeof floorName === "string" ? floorName.trim() : "";

    console.log("Legend mapping:", kind, fileName, "mime:", inlineMimeType, "floor:", floorLabel, "user:", userId);

    const userText = [
      `Sheet type: ${kind.toUpperCase()} — file "${fileName ?? "drawing"}"${floorLabel ? `, floor "${floorLabel}"` : ""}.`,
      "",
      "SHEET GUIDE:",
      KIND_GUIDE[kind],
      "",
      "Transcribe the legend first, then map every labelled room to the legend entries that apply to it.",
    ].join("\n");

    const { response, model, elapsedMs } = await callGemini(
      {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: inlineMimeType, data: base64Data } },
              { text: userText },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.05,
          topP: 0.95,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 4096 },
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      },
      GEMINI_API_KEY,
      { perCallTimeoutMs: heavyCallTimeoutMs() }
    );

    if (!response.ok) {
      return respondGeminiError(res, response.status, await response.text());
    }

    const aiResult = (await response.json()) as GeminiResult;
    const content = extractText(aiResult);
    const finishReason = aiResult?.candidates?.[0]?.finishReason;
    console.log("Legend response:", kind, "length:", content.length, "model:", model, "finishReason:", finishReason, "geminiMs:", elapsedMs);

    let parsed: Record<string, unknown>;
    try {
      parsed = parseAiJson(content) as Record<string, unknown>;
    } catch (parseErr) {
      console.error("Failed to parse legend response:", parseErr, "Head:", content.substring(0, 800));
      return res.status(502).json({ error: "The AI returned an unreadable response for this sheet. Please try again." });
    }

    const legend = (Array.isArray(parsed.legend) ? parsed.legend : [])
      .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
      .map((l, i) => ({
        key: str(l.key) || `L${i + 1}`,
        symbol: str(l.symbol),
        color_hex: /^#[0-9a-f]{6}$/i.test(str(l.color_hex)) ? str(l.color_hex) : "",
        material: str(l.material),
        specification: str(l.specification),
        code: str(l.code),
        size: str(l.size),
        finish: str(l.finish),
        make: str(l.make),
      }));

    const rooms = (Array.isArray(parsed.rooms) ? parsed.rooms : [])
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !!str(r.name))
      .map((r) => ({
        name: str(r.name),
        space_tag: str(r.space_tag),
        bbox: cleanBox(r.bbox),
        legend_keys: strArray(r.legend_keys),
        material: str(r.material),
        material_2: str(r.material_2),
        size: str(r.size),
        finish: str(r.finish),
        code: str(r.code),
        make: str(r.make),
        skirting: str(r.skirting),
        dado: str(r.dado),
        height: str(r.height),
        requirements: str(r.requirements),
      }));

    return res.status(200).json({
      success: true,
      kind,
      model,
      summary: str(parsed.summary),
      legend,
      rooms,
      unmatched_legend_keys: strArray(parsed.unmatched_legend_keys),
      uncertain_rooms: strArray(parsed.uncertain_rooms),
      finish_reason: finishReason ?? null,
    });
  } catch (e) {
    console.error("analyze-legend error:", e);
    return res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
}
