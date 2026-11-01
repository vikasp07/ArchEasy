/**
 * Legend Mapping page.
 *
 * One floor, four discipline drawings (furniture, ceiling, flooring, wall
 * finishes). Each sheet is analysed independently: the AI reads that sheet's
 * legend and says which legend item applies to each room. The rooms are then
 * highlighted on the drawing in their legend colour, and all four results are
 * merged into one room-wise Schedule of Finishes that downloads in the
 * practice's Excel template.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BrickWall,
  Building2,
  FileSpreadsheet,
  Focus,
  Grid3x3,
  Info,
  LampCeiling,
  ListChecks,
  MapPinned,
  Play,
  RotateCw,
  Sofa,
  Trash2,
  Upload,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DrawingViewer from "@/components/DrawingViewer";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFloors } from "@/hooks/useFloors";
import { errorMessage, readJsonResponse, type Drawing, type Room } from "@/lib/types";
import { prepareDrawingForAnalysis, dataUrlBytes, MAX_PAYLOAD_BYTES } from "@/lib/prepareDrawing";
import { downloadSofExcel } from "@/lib/sofExcel";
import {
  DIMMED_COLOR,
  SHEET_FEEDS,
  SHEET_KINDS,
  SHEET_LABEL,
  UNMAPPED_COLOR,
  legendColors,
  legendUsage,
  loadSheets,
  mergeSheets,
  saveSheets,
  viewerDrawing,
  viewerRooms,
  type LegendAnalysis,
  type LegendSheet,
  type LegendSheetKind,
  type LegendSheets,
} from "@/lib/legendMapping";

const SHEET_ICON: Record<LegendSheetKind, typeof Sofa> = {
  furniture: Sofa,
  ceiling: LampCeiling,
  flooring: Grid3x3,
  wall: BrickWall,
};

/** File-name hints used to pre-fill empty slots from drawings already on the floor. */
const NAME_HINTS: Array<[LegendSheetKind, RegExp]> = [
  ["flooring", /flooring|floor\s*finish/i],
  ["ceiling", /ceiling|\brcp\b|reflected/i],
  ["wall", /wall/i],
  ["furniture", /furniture|layout/i],
];

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim().replace(/\s+/g, "_") || "Project";
}

type Busy = "uploading" | "analyzing";

export default function LegendMapping() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const { floors, activeFloorId, setActiveFloorId } = useFloors(id);
  const activeFloor = floors.find((f) => f.id === activeFloorId) ?? null;

  const { data: project } = useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });

  const { data: drawings = [] } = useQuery({
    queryKey: ["drawings", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drawings")
        .select("*")
        .eq("project_id", id!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Drawing[];
    },
  });
  const floorDrawings = useMemo(
    () => drawings.filter((d) => d.floor_id === activeFloorId),
    [drawings, activeFloorId]
  );

  const projectName = project?.name ?? "Project";

  // ------------------------------------------------------------- sheet state
  const [sheets, setSheets] = useState<LegendSheets>({});
  const [busy, setBusy] = useState<Record<string, Busy | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [activeKind, setActiveKind] = useState<LegendSheetKind>("furniture");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [highlightedRoomId, setHighlightedRoomId] = useState<string | null>(null);
  const [analyzingAll, setAnalyzingAll] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Refs so async work started on one floor never writes into another floor.
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const floorRef = useRef(activeFloorId);
  floorRef.current = activeFloorId;
  const filesRef = useRef(new Map<string, File>());
  const inputRefs = useRef<Partial<Record<LegendSheetKind, HTMLInputElement | null>>>({});

  const slot = (floorId: string, kind: LegendSheetKind) => `${floorId}:${kind}`;

  useEffect(() => {
    if (!id || !activeFloorId) return;
    setSheets(loadSheets(id, activeFloorId));
    setFocusKey(null);
    setHighlightedRoomId(null);
  }, [id, activeFloorId]);

  /** Applies a change to one floor's sheets, persisting it, wherever the user is now. */
  const commit = useCallback(
    (floorId: string, change: (prev: LegendSheets) => LegendSheets) => {
      if (!id) return;
      const isCurrent = floorId === floorRef.current;
      const base = isCurrent ? sheetsRef.current : loadSheets(id, floorId);
      const next = change(base);
      saveSheets(id, floorId, next);
      if (isCurrent) {
        sheetsRef.current = next;
        setSheets(next);
      }
    },
    [id]
  );

  // Pre-fill empty slots with drawings already uploaded to this floor, matched by file name.
  useEffect(() => {
    if (!activeFloorId || floorDrawings.length === 0) return;
    const current = sheetsRef.current;
    const additions: LegendSheets = {};
    for (const d of [...floorDrawings].reverse()) {
      const kind = NAME_HINTS.find(([, re]) => re.test(d.file_name))?.[0];
      if (!kind || current[kind] || additions[kind]) continue;
      additions[kind] = {
        kind,
        fileName: d.file_name,
        storagePath: d.storage_path,
        uploadedAt: d.created_at,
      };
    }
    if (Object.keys(additions).length) commit(activeFloorId, (prev) => ({ ...additions, ...prev }));
  }, [activeFloorId, floorDrawings, commit]);

  // ------------------------------------------------------------- upload
  const handleUpload = async (kind: LegendSheetKind, file: File) => {
    const floorId = activeFloorId;
    if (!floorId || !user || !id) return;
    const isPdfOrImage = file.type === "application/pdf" || /\.pdf$/i.test(file.name) || file.type.startsWith("image/");
    if (!isPdfOrImage) {
      toast({ title: "Unsupported file", description: "Upload a PDF or an image.", variant: "destructive" });
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      toast({ title: "File too large", description: "Please upload a drawing under 50MB.", variant: "destructive" });
      return;
    }

    const key = slot(floorId, kind);
    setBusy((b) => ({ ...b, [key]: "uploading" }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    try {
      const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
      const storagePath = `${user.id}/${id}/legend/${floorId}/${kind}_${Date.now()}_${safeName}`;
      const { error } = await supabase.storage.from("drawings").upload(storagePath, file);
      if (error) throw error;

      const previous = (floorId === floorRef.current ? sheetsRef.current : loadSheets(id, floorId))[kind];
      // Only remove files this page uploaded; floor drawings belong to the floor.
      if (previous?.storagePath.includes("/legend/")) {
        void supabase.storage.from("drawings").remove([previous.storagePath]);
      }

      filesRef.current.set(key, file);
      commit(floorId, (prev) => ({
        ...prev,
        [kind]: { kind, fileName: file.name, storagePath, uploadedAt: new Date().toISOString() },
      }));
      setActiveKind(kind);
    } catch (err) {
      toast({ title: "Upload failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setBusy((b) => ({ ...b, [key]: undefined }));
    }
  };

  const handleRemove = (kind: LegendSheetKind) => {
    const floorId = activeFloorId;
    if (!floorId) return;
    const sheet = sheetsRef.current[kind];
    if (sheet?.storagePath.includes("/legend/")) {
      void supabase.storage.from("drawings").remove([sheet.storagePath]);
    }
    filesRef.current.delete(slot(floorId, kind));
    commit(floorId, (prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    setErrors((e) => ({ ...e, [slot(floorId, kind)]: undefined }));
  };

  /** The sheet's file: from memory if just uploaded, else downloaded from storage. */
  const getFile = async (floorId: string, sheet: LegendSheet): Promise<File> => {
    const cached = filesRef.current.get(slot(floorId, sheet.kind));
    if (cached) return cached;
    const { data, error } = await supabase.storage.from("drawings").download(sheet.storagePath);
    if (error || !data) throw error ?? new Error("Could not download the drawing.");
    const type = data.type || (/\.pdf$/i.test(sheet.fileName) ? "application/pdf" : "image/png");
    const file = new File([data], sheet.fileName, { type });
    filesRef.current.set(slot(floorId, sheet.kind), file);
    return file;
  };

  // ------------------------------------------------------------- analysis
  const analyze = async (kind: LegendSheetKind): Promise<boolean> => {
    const floorId = floorRef.current;
    const sheet = sheetsRef.current[kind];
    if (!floorId || !sheet) return false;
    const key = slot(floorId, kind);
    setBusy((b) => ({ ...b, [key]: "analyzing" }));
    setErrors((e) => ({ ...e, [key]: undefined }));

    try {
      const file = await getFile(floorId, sheet);
      const prepared = await prepareDrawingForAnalysis(file);
      if (dataUrlBytes(prepared.dataUrl) > MAX_PAYLOAD_BYTES) {
        throw new Error("This drawing is too detailed to analyse in one request. Export it at a lower resolution.");
      }
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session expired. Please sign in again.");

      const body = JSON.stringify({
        imageBase64: prepared.dataUrl,
        fileName: sheet.fileName,
        mimeType: prepared.mimeType,
        floorName: activeFloor?.name ?? "",
        kind,
      });

      let payload!: LegendAnalysis;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await fetch("/api/analyze-legend", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
        });
        payload = await readJsonResponse<LegendAnalysis>(res);
        if (res.ok) break;
        if (!TRANSIENT.has(res.status) || attempt === 2) {
          throw new Error(payload?.error || `Analysis failed (${res.status})`);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }

      const analysis: LegendAnalysis = {
        kind,
        model: payload.model,
        summary: payload.summary ?? "",
        legend: payload.legend ?? [],
        rooms: payload.rooms ?? [],
        unmatched_legend_keys: payload.unmatched_legend_keys ?? [],
        uncertain_rooms: payload.uncertain_rooms ?? [],
        finish_reason: payload.finish_reason ?? null,
      };
      commit(floorId, (prev) =>
        prev[kind] ? { ...prev, [kind]: { ...prev[kind]!, analysis, analyzedAt: new Date().toISOString() } } : prev
      );
      toast({
        title: `${SHEET_LABEL[kind]} mapped`,
        description: `${analysis.legend.length} legend item(s) across ${analysis.rooms.length} room(s).`,
      });
      return true;
    } catch (err) {
      const message = errorMessage(err);
      setErrors((e) => ({ ...e, [key]: message }));
      toast({ title: `${SHEET_LABEL[kind]} failed`, description: message, variant: "destructive" });
      return false;
    } finally {
      setBusy((b) => ({ ...b, [key]: undefined }));
    }
  };

  /** Sheets run one after another: in parallel they trip Gemini's per-minute quota. */
  const analyzeAll = async () => {
    setAnalyzingAll(true);
    try {
      for (const kind of SHEET_KINDS) {
        if (!sheetsRef.current[kind]) continue;
        setActiveKind(kind);
        await analyze(kind);
      }
    } finally {
      setAnalyzingAll(false);
    }
  };

  // ------------------------------------------------------------- derived
  const mapped = useMemo(() => mergeSheets(sheets), [sheets]);
  const uploadedCount = SHEET_KINDS.filter((k) => sheets[k]).length;
  const analyzedCount = SHEET_KINDS.filter((k) => sheets[k]?.analysis).length;
  const anyBusy = Object.values(busy).some(Boolean);

  const activeSheet = sheets[activeKind];
  const activeAnalysis = activeSheet?.analysis;
  const colors = useMemo(() => legendColors(activeAnalysis?.legend ?? []), [activeAnalysis]);
  const usage = useMemo(() => (activeAnalysis ? legendUsage(activeAnalysis) : new Map<string, number>()), [activeAnalysis]);
  const rooms = useMemo(() => (activeSheet ? viewerRooms(activeSheet) : []), [activeSheet]);
  const drawing = useMemo(
    () => (activeSheet && id && activeFloorId ? viewerDrawing(activeSheet, id, activeFloorId) : null),
    [activeSheet, id, activeFloorId]
  );
  const shownKey = previewKey ?? focusKey;

  const roomColor = useCallback(
    (room: Room) => {
      const index = Number(room.id.split("-").pop());
      const keys = activeAnalysis?.rooms[index]?.legend_keys ?? [];
      if (shownKey) return keys.includes(shownKey) ? colors.get(shownKey) ?? UNMAPPED_COLOR : DIMMED_COLOR;
      return (keys.length && colors.get(keys[0])) || UNMAPPED_COLOR;
    },
    [activeAnalysis, colors, shownKey]
  );

  useEffect(() => {
    setFocusKey(null);
    setPreviewKey(null);
    setHighlightedRoomId(null);
  }, [activeKind]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const floorName = activeFloor?.name ?? "Floor";
      await downloadSofExcel(
        [{ floorName, rooms: mapped }],
        projectName,
        `${fileSafe(projectName)}_${fileSafe(floorName)}_Legend_Mapped_SOF.xlsx`
      );
    } catch (err) {
      toast({ title: "Excel export failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  // ------------------------------------------------------------- render
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/project/${id}`)} aria-label="Back to project">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-primary">
            <MapPinned className="h-4 w-4 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold font-heading leading-tight text-foreground">Legend Mapping</h1>
            <p className="flex items-center gap-1 truncate text-[11px] leading-tight text-muted-foreground">
              <Building2 className="h-2.5 w-2.5" />
              {projectName}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {floors.length > 0 && (
              <Select value={activeFloorId ?? undefined} onValueChange={setActiveFloorId} disabled={anyBusy}>
                <SelectTrigger className="h-9 w-[150px] text-xs" aria-label="Floor">
                  <SelectValue placeholder="Select floor" />
                </SelectTrigger>
                <SelectContent>
                  {floors.map((f) => (
                    <SelectItem key={f.id} value={f.id} className="text-xs">
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={analyzeAll}
              disabled={uploadedCount === 0 || anyBusy}
            >
              {analyzingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Analyze all</span>
            </Button>
            <Button
              size="sm"
              className="gap-1.5 gradient-primary text-primary-foreground"
              onClick={handleExport}
              disabled={mapped.length === 0 || exporting}
            >
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Download Excel</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6">
        <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Add the four drawings for <span className="font-medium text-foreground">{activeFloor?.name ?? "this floor"}</span>.
            Each sheet is analysed on its own: the AI reads its legend and maps every room to the legend item that applies.
            The results are combined room by room into your Schedule of Finishes template. Each sheet takes about a minute
            or two to analyse. AI readings can be wrong, so check them against the drawings before issuing the schedule.
          </p>
        </div>

        {/* Sheet slots */}
        <section aria-label="Drawings" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SHEET_KINDS.map((kind) => {
            const Icon = SHEET_ICON[kind];
            const sheet = sheets[kind];
            const key = activeFloorId ? slot(activeFloorId, kind) : kind;
            const state = busy[key];
            const error = errors[key];
            const isActive = activeKind === kind;
            return (
              <div
                key={kind}
                className={`flex flex-col rounded-xl border bg-card p-3 shadow-card transition-colors ${
                  isActive ? "border-primary/50 ring-1 ring-primary/20" : "border-border"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveKind(kind)}
                  className="flex items-start gap-2 text-left"
                  aria-pressed={isActive}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blueprint-light">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{SHEET_LABEL[kind]}</p>
                    <p className="text-[11px] leading-snug text-muted-foreground">{SHEET_FEEDS[kind]}</p>
                  </div>
                </button>

                <div className="mt-3 min-h-[38px] rounded-lg bg-muted/40 px-2.5 py-2 text-[11px]">
                  {!sheet ? (
                    <span className="text-muted-foreground">No drawing yet</span>
                  ) : (
                    <>
                      <p className="truncate font-medium text-foreground" title={sheet.fileName}>
                        {sheet.fileName}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                        {state === "uploading" ? (
                          <><Loader2 className="h-3 w-3 animate-spin" /> Uploading…</>
                        ) : state === "analyzing" ? (
                          <><Loader2 className="h-3 w-3 animate-spin" /> Reading legend…</>
                        ) : error ? (
                          <><AlertTriangle className="h-3 w-3 text-destructive" /> <span className="text-destructive">Failed</span></>
                        ) : sheet.analysis ? (
                          <><CheckCircle2 className="h-3 w-3 text-success" /> {sheet.analysis.legend.length} legend · {sheet.analysis.rooms.length} rooms</>
                        ) : (
                          "Ready to analyse"
                        )}
                      </p>
                    </>
                  )}
                </div>
                {error && <p className="mt-1.5 text-[11px] leading-snug text-destructive">{error}</p>}

                <input
                  ref={(el) => (inputRefs.current[kind] = el)}
                  type="file"
                  accept="application/pdf,image/*"
                  className="hidden"
                  aria-label={`Upload ${SHEET_LABEL[kind]}`}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void handleUpload(kind, file);
                  }}
                />
                <div className="mt-3 flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 flex-1 gap-1 text-xs"
                    onClick={() => inputRefs.current[kind]?.click()}
                    disabled={!!state || !activeFloorId}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {sheet ? "Replace" : "Upload"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 flex-1 gap-1 text-xs"
                    onClick={() => void analyze(kind)}
                    disabled={!sheet || !!state || analyzingAll}
                  >
                    {sheet?.analysis ? <RotateCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {sheet?.analysis ? "Re-analyse" : "Analyse"}
                  </Button>
                  {sheet && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0"
                      onClick={() => handleRemove(kind)}
                      disabled={!!state}
                      aria-label={`Remove ${SHEET_LABEL[kind]}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Drawing + legend */}
        <section aria-label={`${SHEET_LABEL[activeKind]} legend`} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-h-[520px]">
            {drawing ? (
              <DrawingViewer
                drawing={drawing}
                rooms={rooms}
                highlightedRoomId={highlightedRoomId}
                onHighlightRoom={setHighlightedRoomId}
                readOnly
                roomColor={roomColor}
              />
            ) : (
              <div className="flex h-full min-h-[520px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center">
                <p className="text-sm font-medium text-foreground">No {SHEET_LABEL[activeKind].toLowerCase()} yet</p>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  Upload it above. After analysis, each room is outlined in the colour of its legend item.
                </p>
              </div>
            )}
          </div>

          <aside className="flex max-h-[640px] flex-col rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <ListChecks className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold font-heading text-foreground">{SHEET_LABEL[activeKind]} legend</h2>
              {focusKey && (
                <button
                  type="button"
                  onClick={() => setFocusKey(null)}
                  className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" /> Show all
                </button>
              )}
            </div>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
              {!activeAnalysis ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {activeSheet ? "Analyse this sheet to read its legend." : "No drawing for this sheet yet."}
                </p>
              ) : activeAnalysis.legend.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">No legend was found on this sheet.</p>
              ) : (
                activeAnalysis.legend.map((item) => {
                  const color = colors.get(item.key) ?? UNMAPPED_COLOR;
                  const count = usage.get(item.key) ?? 0;
                  const isFocus = focusKey === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setFocusKey(isFocus ? null : item.key)}
                      onMouseEnter={() => setPreviewKey(item.key)}
                      onMouseLeave={() => setPreviewKey(null)}
                      onFocus={() => setPreviewKey(item.key)}
                      onBlur={() => setPreviewKey(null)}
                      aria-pressed={isFocus}
                      className={`flex w-full items-start gap-2 rounded-lg border p-2 text-left transition-colors ${
                        isFocus ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 rounded"
                        style={{ backgroundColor: color.replace(/\)\s*$/, " / 0.25)"), border: `2px solid ${color}` }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">{item.key}</span>
                          <span className="truncate text-xs font-medium text-foreground">{item.material || item.symbol || "Legend item"}</span>
                        </span>
                        {item.specification && (
                          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{item.specification}</span>
                        )}
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {count} room{count === 1 ? "" : "s"}
                          {item.symbol ? ` · ${item.symbol}` : ""}
                        </span>
                      </span>
                      {isFocus && <Focus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
                    </button>
                  );
                })
              )}

              {activeAnalysis && (activeAnalysis.uncertain_rooms.length > 0 || activeAnalysis.unmatched_legend_keys.length > 0 || (activeAnalysis.finish_reason && activeAnalysis.finish_reason !== "STOP")) && (
                <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-2.5">
                  <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-warning">
                    <AlertTriangle className="h-3 w-3" /> Verify
                  </p>
                  <ul className="space-y-1 text-[11px] leading-snug text-foreground/85">
                    {activeAnalysis.unmatched_legend_keys.length > 0 && (
                      <li>Legend items not found on any room: {activeAnalysis.unmatched_legend_keys.join(", ")}</li>
                    )}
                    {activeAnalysis.uncertain_rooms.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                    {activeAnalysis.finish_reason && activeAnalysis.finish_reason !== "STOP" && (
                      <li>The AI response ended early ({activeAnalysis.finish_reason}); some rooms may be missing.</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          </aside>
        </section>

        {/* Mapped schedule */}
        <section aria-label="Mapped Schedule of Finishes" className="rounded-xl border border-border bg-card">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold font-heading text-foreground">Mapped Schedule of Finishes</h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {mapped.length} room{mapped.length === 1 ? "" : "s"} · {analyzedCount}/4 sheets
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">Hover a row to find it on the drawing</span>
          </header>
          {mapped.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              Analyse at least one sheet to start building the schedule.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-xs">
                <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">#</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Space</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Flooring</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Skirting</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Ceiling</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Wall</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Requirements / remark</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Sheets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {mapped.map((row, i) => {
                    const onSheet = row.sheetRoomIds[activeKind];
                    const isHot = !!onSheet && highlightedRoomId === onSheet;
                    const cell = (...parts: Array<string | null>) =>
                      parts.filter(Boolean).join(" · ") || <span className="text-muted-foreground">—</span>;
                    return (
                      <tr
                        key={row.key}
                        onMouseEnter={() => onSheet && setHighlightedRoomId(onSheet)}
                        onMouseLeave={() => setHighlightedRoomId(null)}
                        className={isHot ? "bg-primary/5" : "hover:bg-muted/30"}
                      >
                        <td className="px-3 py-2 align-top tabular-nums text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2 align-top">
                          <span className="font-medium text-foreground">{row.name}</span>
                          {row.space_tag && <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{row.space_tag}</span>}
                        </td>
                        <td className="px-3 py-2 align-top">{cell(row.floor_finish, row.flooring_size, row.flooring_finish, row.flooring_code)}</td>
                        <td className="px-3 py-2 align-top">{cell(row.skirting)}</td>
                        <td className="px-3 py-2 align-top">{cell(row.ceiling_finish, row.ceiling_material_2, row.ceiling_size)}</td>
                        <td className="px-3 py-2 align-top">{cell(row.wall_finish, row.paint_color, row.dado)}</td>
                        <td className="max-w-[280px] px-3 py-2 align-top text-muted-foreground">{row.remark ?? "—"}</td>
                        <td className="px-3 py-2 align-top">
                          <span className="flex gap-1">
                            {SHEET_KINDS.map((k) => {
                              const Icon = SHEET_ICON[k];
                              const has = !!row.sheetRoomIds[k];
                              return (
                                <Icon
                                  key={k}
                                  className={`h-3.5 w-3.5 ${has ? "text-primary" : "text-muted-foreground/30"}`}
                                  aria-label={`${SHEET_LABEL[k]}: ${has ? "found" : "not found"}`}
                                />
                              );
                            })}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
