/**
 * Legend Mapping: the four discipline drawings of one floor (furniture,
 * ceiling, flooring, wall finishes) are analysed independently by
 * /api/analyze-legend. This module holds the shared types, merges the four
 * results into one room-wise Schedule of Finishes, and assigns legend colours
 * for the drawing overlays.
 */
import type { Drawing, Room } from "@/lib/types";
import type { SofRoom } from "@/lib/sofExcel";

export type LegendSheetKind = "furniture" | "ceiling" | "flooring" | "wall";

export const SHEET_KINDS: LegendSheetKind[] = ["furniture", "ceiling", "flooring", "wall"];

export const SHEET_LABEL: Record<LegendSheetKind, string> = {
  furniture: "Furniture Layout",
  ceiling: "Ceiling Plan",
  flooring: "Flooring Plan",
  wall: "Wall Finishes",
};

/** Which Schedule of Finishes columns each sheet fills. */
export const SHEET_FEEDS: Record<LegendSheetKind, string> = {
  furniture: "Room list, tags, requirements",
  ceiling: "Ceiling material 1 & 2, size, code, make",
  flooring: "Flooring material, size, finish, code, make, skirting",
  wall: "Wall finish, paint colour, dado",
};

export interface LegendItem {
  key: string;
  symbol: string;
  color_hex: string;
  material: string;
  specification: string;
  code: string;
  size: string;
  finish: string;
  make: string;
}

export interface LegendRoom {
  name: string;
  space_tag: string;
  bbox: number[] | null;
  legend_keys: string[];
  material: string;
  material_2: string;
  size: string;
  finish: string;
  code: string;
  make: string;
  skirting: string;
  dado: string;
  height: string;
  requirements: string;
}

export interface LegendAnalysis {
  kind: LegendSheetKind;
  model?: string;
  summary: string;
  legend: LegendItem[];
  rooms: LegendRoom[];
  unmatched_legend_keys: string[];
  uncertain_rooms: string[];
  finish_reason: string | null;
  error?: string;
}

/** One uploaded sheet, persisted per project + floor. */
export interface LegendSheet {
  kind: LegendSheetKind;
  fileName: string;
  storagePath: string;
  uploadedAt: string;
  analysis?: LegendAnalysis;
  analyzedAt?: string;
}

export type LegendSheets = Partial<Record<LegendSheetKind, LegendSheet>>;

// ---------------------------------------------------------------- persistence
// Results live in localStorage so a ~90s-per-sheet analysis survives a reload.
// The drawings themselves are in Supabase storage (storagePath).

const storageKey = (projectId: string, floorId: string) => `archeasy:legend:${projectId}:${floorId}`;

export function loadSheets(projectId: string, floorId: string): LegendSheets {
  try {
    const raw = localStorage.getItem(storageKey(projectId, floorId));
    return raw ? (JSON.parse(raw) as LegendSheets) : {};
  } catch {
    return {};
  }
}

export function saveSheets(projectId: string, floorId: string, sheets: LegendSheets) {
  try {
    localStorage.setItem(storageKey(projectId, floorId), JSON.stringify(sheets));
  } catch (err) {
    console.warn("Could not persist legend mapping:", err);
  }
}

// ---------------------------------------------------------------- colours
// RoomOverlayBox expects `hsl(H S% L%)` (it appends an alpha channel).

const PALETTE = [
  "hsl(215 80% 48%)", "hsl(340 75% 55%)", "hsl(152 60% 38%)", "hsl(25 95% 50%)",
  "hsl(262 70% 56%)", "hsl(190 85% 38%)", "hsl(45 90% 45%)", "hsl(0 72% 50%)",
  "hsl(290 60% 48%)", "hsl(120 45% 40%)", "hsl(205 30% 40%)", "hsl(15 60% 42%)",
];

export const UNMAPPED_COLOR = "hsl(215 15% 55%)";
export const DIMMED_COLOR = "hsl(215 12% 78%)";

function hexToHsl(hex: string): string | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round((h * 60 + 360) % 360);
  // Keep very light swatches (pale fills) readable as an outline on white.
  const light = Math.min(Math.round(l * 100), 55);
  return `hsl(${h} ${Math.max(Math.round(s * 100), 35)}% ${Math.max(light, 30)}%)`;
}

/** Stable colour per legend key: the swatch colour when the legend has one, else the palette. */
export function legendColors(legend: LegendItem[]): Map<string, string> {
  const map = new Map<string, string>();
  legend.forEach((item, i) => {
    map.set(item.key, hexToHsl(item.color_hex) ?? PALETTE[i % PALETTE.length]);
  });
  return map;
}

// ---------------------------------------------------------------- viewer adapters
// DrawingViewer works on saved Drawing / Room rows. Legend sheets are not saved
// rows, so these build view-only stand-ins (the viewer is used readOnly).

export function viewerDrawing(sheet: LegendSheet, projectId: string, floorId: string): Drawing {
  return {
    id: `legend-${floorId}-${sheet.kind}`,
    project_id: projectId,
    floor_id: floorId,
    file_name: sheet.fileName,
    storage_path: sheet.storagePath,
    analysis_meta: null,
  } as unknown as Drawing;
}

export const viewerRoomId = (kind: LegendSheetKind, index: number) => `${kind}-${index}`;

export function viewerRooms(sheet: LegendSheet): Room[] {
  return (sheet.analysis?.rooms ?? []).map(
    (r, i) =>
      ({
        id: viewerRoomId(sheet.kind, i),
        name: r.name,
        space_tag: r.space_tag || null,
        room_type: null,
        bbox: r.bbox,
      }) as unknown as Room
  );
}

// ---------------------------------------------------------------- merge

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" / ");

export interface MappedRoom extends SofRoom {
  /** Stable merge key, shared by the same space on every sheet. */
  key: string;
  /** Viewer room id of this space on each sheet that has it. */
  sheetRoomIds: Partial<Record<LegendSheetKind, string>>;
  ceiling_height: string;
}

/**
 * Keys a sheet's rooms so the same space on different sheets lines up.
 * Repeated labels ("6P MR" x3) get an occurrence index, numbered in reading
 * order (top-to-bottom, left-to-right) on that sheet.
 */
function keyedRooms(rooms: LegendRoom[]): Array<{ key: string; room: LegendRoom; index: number }> {
  const order = rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => (a.room.bbox?.[0] ?? 0) - (b.room.bbox?.[0] ?? 0) || (a.room.bbox?.[1] ?? 0) - (b.room.bbox?.[1] ?? 0));
  const seen = new Map<string, number>();
  const keyed = order.map(({ room, index }) => {
    const base = `${norm(room.name)}|${norm(room.space_tag)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, room, index };
  });
  // Back to the sheet's own order so the schedule follows the drawing's reading.
  return keyed.sort((a, b) => a.index - b.index);
}

const emptyMapped = (key: string, room: LegendRoom): MappedRoom => ({
  key,
  sheetRoomIds: {},
  name: room.name,
  space_tag: room.space_tag || null,
  floor_finish: null,
  flooring_size: null,
  flooring_finish: null,
  flooring_code: null,
  flooring_make: null,
  flooring_rate: null,
  skirting: null,
  skirting_code: null,
  skirting_make: null,
  skirting_rate: null,
  ceiling_finish: null,
  ceiling_material_2: null,
  ceiling_size: null,
  ceiling_code: null,
  ceiling_make: null,
  ceiling_rate: null,
  remark: null,
  wall_finish: null,
  paint_color: null,
  dado: null,
  ceiling_height: "",
});

/** Fills a legend field from the room's own value, falling back to its legend entry. */
function pick(room: LegendRoom, legend: Map<string, LegendItem>, field: keyof LegendItem & keyof LegendRoom) {
  const own = room[field];
  if (typeof own === "string" && own) return own;
  for (const k of room.legend_keys) {
    const v = legend.get(k)?.[field];
    if (v) return v;
  }
  return "";
}

/**
 * Merges the analysed sheets into one Schedule of Finishes, room by room.
 * The furniture layout defines the room list; spaces that appear only on
 * another sheet are appended so nothing is dropped.
 */
export function mergeSheets(sheets: LegendSheets): MappedRoom[] {
  const rows = new Map<string, MappedRoom>();
  const requirements = new Map<string, string[]>();

  for (const kind of SHEET_KINDS) {
    const analysis = sheets[kind]?.analysis;
    if (!analysis) continue;
    const legend = new Map(analysis.legend.map((l) => [l.key, l]));

    for (const { key, room, index } of keyedRooms(analysis.rooms)) {
      let row = rows.get(key);
      if (!row) {
        row = emptyMapped(key, room);
        rows.set(key, row);
      }
      row.sheetRoomIds[kind] = viewerRoomId(kind, index);
      if (!row.space_tag && room.space_tag) row.space_tag = room.space_tag;

      const material = pick(room, legend, "material");
      const size = pick(room, legend, "size");
      const finish = pick(room, legend, "finish");
      const code = pick(room, legend, "code");
      const make = pick(room, legend, "make");

      if (kind === "flooring") {
        row.floor_finish = material || row.floor_finish;
        row.flooring_size = size || row.flooring_size;
        row.flooring_finish = finish || row.flooring_finish;
        row.flooring_code = code || row.flooring_code;
        row.flooring_make = make || row.flooring_make;
        row.skirting = room.skirting || row.skirting;
      } else if (kind === "ceiling") {
        row.ceiling_finish = material || row.ceiling_finish;
        row.ceiling_material_2 = room.material_2 || row.ceiling_material_2;
        row.ceiling_size = size || row.ceiling_size;
        row.ceiling_code = code || row.ceiling_code;
        row.ceiling_make = make || row.ceiling_make;
        row.ceiling_height = room.height || row.ceiling_height;
      } else if (kind === "wall") {
        // A room can carry several wall legend items: list them all.
        const allWalls = room.legend_keys.map((k) => legend.get(k)?.material ?? "").filter(Boolean);
        row.wall_finish = join(material, ...allWalls.filter((w) => w !== material)) || row.wall_finish;
        row.paint_color = room.material_2 || row.paint_color;
        row.dado = room.dado || row.dado;
      }

      if (room.requirements) {
        const list = requirements.get(key) ?? [];
        list.push(kind === "furniture" ? room.requirements : `${SHEET_LABEL[kind]}: ${room.requirements}`);
        requirements.set(key, list);
      }
    }
  }

  for (const [key, row] of rows) {
    const reqs = requirements.get(key) ?? [];
    const height = row.ceiling_height ? [`Ceiling height: ${row.ceiling_height}`] : [];
    row.remark = [...reqs, ...height].join("; ") || null;
  }
  return [...rows.values()];
}

/** How many rooms on a sheet use each legend key. */
export function legendUsage(analysis: LegendAnalysis): Map<string, number> {
  const usage = new Map<string, number>();
  for (const r of analysis.rooms) for (const k of r.legend_keys) usage.set(k, (usage.get(k) ?? 0) + 1);
  return usage;
}
