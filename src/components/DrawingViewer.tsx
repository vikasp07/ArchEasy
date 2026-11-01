import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Tag,
  SquareDashedMousePointer,
  FileText,
  Image as ImageIcon,
  Loader2,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Expand,
  Shrink,
  PencilRuler,
  SquarePlus,
  Lasso,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import PdfCanvas, { type RenderedPageSize } from "@/components/PdfCanvas";
import RoomOverlayBox from "@/components/RoomOverlayBox";
import BoxDrawLayer from "@/components/BoxDrawLayer";
import FreeformDrawLayer from "@/components/FreeformDrawLayer";
import NewRoomPanel from "@/components/NewRoomPanel";
import { useRoomEdits } from "@/hooks/useRoomEdits";
import { centredBox, labelSuggestions, boxesEqual } from "@/lib/bboxEdit";
import { parseAnalysisMeta, parseBBox, type BBox, type Room, type Drawing } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import ShapeEditPrompt from "@/components/ShapeEditPrompt";

interface Props {
  drawing: Drawing | null;
  rooms: Room[];
  highlightedRoomId: string | null;
  onHighlightRoom: (id: string | null) => void;
  /** Active floor name, stored on rooms the user adds by hand. */
  floorName?: string;
  /**
   * View-only: hides the edit tools. For drawings whose rooms are not saved
   * rows (e.g. the Legend Mapping page), where editing has nothing to save to.
   */
  readOnly?: boolean;
  /** Overrides the default colour-by-room-type for each overlay box. */
  roomColor?: (room: Room) => string;
  /**
   * Called when a room box is clicked (outside edit mode). When provided it
   * replaces the default click behaviour of toggling the highlight.
   */
  onRoomClick?: (id: string) => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

/** Colour a room overlay by its type so finishes group visually. */
function roomTypeColor(roomType: string | null): string {
  switch (roomType) {
    case "bathroom":
      return "hsl(199 89% 48%)";
    case "kitchen":
      return "hsl(25 95% 53%)";
    case "bedroom":
      return "hsl(262 83% 58%)";
    case "living":
    case "dining":
      return "hsl(152 60% 42%)";
    case "lobby":
    case "hallway":
      return "hsl(215 80% 48%)";
    case "staircase":
      return "hsl(340 75% 55%)";
    case "utility":
    case "service":
    case "storage":
      return "hsl(215 15% 50%)";
    case "balcony":
      return "hsl(175 60% 40%)";
    case "office":
      return "hsl(240 70% 55%)";
    case "parking":
    case "garage":
      return "hsl(38 92% 50%)";
    default:
      return "hsl(215 80% 48%)";
  }
}

export default function DrawingViewer({
  drawing,
  rooms,
  highlightedRoomId,
  onHighlightRoom,
  floorName,
  readOnly = false,
  roomColor,
  onRoomClick,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [isPanning, setIsPanning] = useState(false);

  // Box editing: move / resize / rename overlays directly on the drawing.
  const [editMode, setEditMode] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  // Adding rooms: drawMode = next drag draws a box; freeformMode = lasso draw.
  // pendingBox = drawn box awaiting a name.
  const [drawMode, setDrawMode] = useState(false);
  const [freeformMode, setFreeformMode] = useState(false);
  const [pendingBox, setPendingBox] = useState<BBox | null>(null);
  const [pendingShapeEdit, setPendingShapeEdit] = useState<{
    roomId: string;
    roomName: string;
    originalBox: BBox;
    newBox: BBox;
  } | null>(null);
  const [boxHistory, setBoxHistory] = useState<{
    roomId: string;
    roomName: string;
    boxBefore: BBox;
    boxAfter: BBox;
  }[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  const { updateBox, renameRoom, createRoom, isSaving, isCreating } = useRoomEdits(
    drawing?.project_id
  );

  // PDF-specific: current page + the last rendered page's size / count.
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfInfo, setPdfInfo] = useState<RenderedPageSize | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const [containerSize, setContainerSize] = useState({ width: 900, height: 600 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isPdf = (drawing?.file_name ?? "").toLowerCase().endsWith(".pdf");

  // Signed URL: the drawings bucket is private, so a public URL won't load.
  const { data: signedUrl, isLoading: urlLoading } = useQuery({
    queryKey: ["drawing-url", drawing?.storage_path],
    enabled: !!drawing?.storage_path,
    // Refresh comfortably before the 1 hour expiry.
    staleTime: 45 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from("drawings")
        .createSignedUrl(drawing!.storage_path, 60 * 60);
      if (error) throw error;
      return data.signedUrl;
    },
  });

  const roomsWithBoxes = useMemo(
    () =>
      rooms
        .map((room) => {
          const isPending = pendingShapeEdit && pendingShapeEdit.roomId === room.id;
          const box = isPending ? pendingShapeEdit.newBox : parseBBox(room.bbox);
          return { room, box };
        })
        .filter((r): r is { room: Room; box: [number, number, number, number] } => r.box !== null),
    [rooms, pendingShapeEdit]
  );

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );

  const selectedRoomBox = useMemo(
    () => roomsWithBoxes.find((r) => r.room.id === selectedRoomId)?.box ?? null,
    [roomsWithBoxes, selectedRoomId]
  );

  const placedRooms = useMemo(
    () => roomsWithBoxes.map((r) => r.room),
    [roomsWithBoxes]
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Reset the view + PDF page when the drawing changes so a new floor starts clean.
  useEffect(() => {
    resetView();
    setPdfPage(1);
    setPdfInfo(null);
    setEditMode(false);
    setSelectedRoomId(null);
    setDrawMode(false);
    setFreeformMode(false);
    setPendingBox(null);
    setPendingShapeEdit(null);
    setBoxHistory([]);
  }, [drawing?.id, resetView]);

  // Track the canvas container size so the whole sheet fits it at 100% zoom.
  // Re-attaches when a drawing first appears (the container isn't mounted before).
  const hasDrawing = !!drawing;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setContainerSize((prev) => {
        const width = el.clientWidth || 900;
        const height = el.clientHeight || 600;
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasDrawing]);

  /** Space inside the canvas for the sheet, leaving a small margin. */
  const fitWidth = Math.max(240, containerSize.width - 24);
  const fitHeight = Math.max(240, containerSize.height - 24);

  /**
   * PDF render width that fits the whole page (width AND height). Uses the
   * page's aspect from the last render; the first render fits width only,
   * then settles at the fitted size.
   */
  const pdfRenderWidth = (() => {
    const aspect = pdfInfo && pdfInfo.height > 0 ? pdfInfo.width / pdfInfo.height : null;
    const width = aspect ? Math.min(fitWidth, fitHeight * aspect) : fitWidth;
    return Math.round(Math.max(320, Math.min(width, 2400)));
  })();

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => clampZoom(z * delta));
  };

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Boxes stop propagation in edit mode, so this is a press on empty canvas.
    setSelectedRoomId(null);
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, offsetX: offset.x, offsetY: offset.y };
  };

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      setOffset({
        x: panStart.current.offsetX + (e.clientX - panStart.current.x),
        y: panStart.current.offsetY + (e.clientY - panStart.current.y),
      });
    };
    const onUp = () => setIsPanning(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isPanning]);

  const handleRendered = useCallback((size: RenderedPageSize) => setPdfInfo(size), []);

  // Full screen the whole viewer (toolbar + canvas + overlays) via the
  // Fullscreen API, so highlights stay on top — unlike opening the raw PDF.
  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Overlays are anchored to the sheet the AI analysed. For PDFs we only trust
  // page 1 (a floor plan is virtually always a single sheet).
  const onAnalysedSheet = showAnnotations && (!isPdf || pdfPage === 1);

  // Editing needs the analysed sheet on screen, but not existing boxes: a drawing
  // where the AI placed nothing can still have boxes added by hand.
  const editing = !readOnly && editMode && onAnalysedSheet;
  const drawingBox = editing && drawMode && !freeformMode && !pendingBox;
  const drawingFreeform = editing && freeformMode && !pendingBox;

  const getLayerRect = useCallback(
    () => overlayRef.current?.getBoundingClientRect() ?? null,
    []
  );

  const handleRoomClick = useCallback(
    (id: string) => {
      if (onRoomClick) onRoomClick(id);
      else onHighlightRoom(highlightedRoomId === id ? null : id);
    },
    [highlightedRoomId, onHighlightRoom, onRoomClick]
  );

  /** Rooms of this drawing with no box: a newly drawn box can be attached to one of them. */
  const unplacedRooms = useMemo(() => rooms.filter((r) => parseBBox(r.bbox) === null), [rooms]);

  /** Labels the AI read but could not place, offered as names for new boxes. */
  const nameSuggestions = useMemo(() => {
    const meta = parseAnalysisMeta(drawing?.analysis_meta);
    const candidates = [...(meta?.undetected_spaces ?? []), ...(meta?.unmatched_labels ?? [])];
    return labelSuggestions(
      candidates,
      rooms.map((r) => r.name)
    );
  }, [drawing?.analysis_meta, rooms]);

  const handleBoxDrawn = useCallback((box: BBox) => {
    setDrawMode(false);
    setSelectedRoomId(null);
    setPendingBox(box);
  }, []);

  const handleStartFreeform = useCallback((roomId: string) => {
    setSelectedRoomId(roomId);
    setDrawMode(false);
    setFreeformMode(true);
  }, []);

  const handleFreeformDrawn = useCallback(
    (box: BBox, targetRoomId?: string | null) => {
      if (targetRoomId) {
        const target = rooms.find((r) => r.id === targetRoomId);
        const originalBox = parseBBox(target?.bbox);
        if (originalBox) {
          setPendingShapeEdit({
            roomId: targetRoomId,
            roomName: target?.name ?? "Room",
            originalBox,
            newBox: box,
          });
          setFreeformMode(false);
          setSelectedRoomId(targetRoomId);
        } else {
          updateBox(targetRoomId, box);
          setFreeformMode(false);
          setSelectedRoomId(targetRoomId);
        }
      } else {
        handleBoxDrawn(box);
      }
    },
    [handleBoxDrawn, rooms, updateBox]
  );

  const handleSaveShapeEdit = useCallback(() => {
    if (!pendingShapeEdit) return;
    const { roomId, roomName, originalBox, newBox } = pendingShapeEdit;
    setBoxHistory((prev) => [
      ...prev,
      { roomId, roomName, boxBefore: originalBox, boxAfter: newBox },
    ]);
    updateBox(roomId, newBox);
    toast({
      title: "Shape changes saved",
      description: `Updated boundaries for ${roomName}.`,
    });
    setPendingShapeEdit(null);
  }, [pendingShapeEdit, toast, updateBox]);

  const handleUndoShapeEdit = useCallback(() => {
    if (!pendingShapeEdit) return;
    const { roomName } = pendingShapeEdit;
    setPendingShapeEdit(null);
    toast({
      title: "Shape changes undone",
      description: `Reverted ${roomName} to its original boundaries.`,
    });
  }, [pendingShapeEdit, toast]);

  const handleUndoLastChange = useCallback(() => {
    if (pendingShapeEdit) {
      handleUndoShapeEdit();
      return;
    }
    if (boxHistory.length === 0) return;
    const last = boxHistory[boxHistory.length - 1];
    setBoxHistory((prev) => prev.slice(0, -1));
    updateBox(last.roomId, last.boxBefore);
    setSelectedRoomId(last.roomId);
    toast({
      title: "Shape change undone",
      description: `Reverted ${last.roomName} to previous shape.`,
    });
  }, [boxHistory, handleUndoShapeEdit, pendingShapeEdit, toast, updateBox]);

  const handleCommitBox = useCallback(
    (id: string, box: BBox, previousBox?: BBox) => {
      if (previousBox && !boxesEqual(box, previousBox)) {
        const room = rooms.find((r) => r.id === id);
        setBoxHistory((prev) => [
          ...prev,
          {
            roomId: id,
            roomName: room?.name ?? "Room",
            boxBefore: previousBox,
            boxAfter: box,
          },
        ]);
      }
      updateBox(id, box);
    },
    [rooms, updateBox]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        handleUndoLastChange();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndoLastChange]);

  const cancelPendingBox = useCallback(() => {
    setPendingBox(null);
    addButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const handleCreateRoom = async ({ name, roomType }: { name: string; roomType: string }) => {
    if (!drawing || !pendingBox) return;
    try {
      const room = await createRoom({
        drawing,
        name,
        roomType,
        bbox: pendingBox,
        floorLevel: floorName ?? "",
      });
      setPendingBox(null);
      // Select it for immediate adjusting and light up its card below.
      setSelectedRoomId(room.id);
      onHighlightRoom(room.id);
    } catch {
      // The hook already showed a toast; keep the panel open so the user can retry.
    }
  };

  const handleAssignBox = (roomId: string) => {
    if (!pendingBox) return;
    const room = rooms.find((r) => r.id === roomId);
    const originalBox = parseBBox(room?.bbox);
    const boxToAssign = pendingBox;
    setPendingBox(null);
    if (originalBox) {
      setPendingShapeEdit({
        roomId,
        roomName: room?.name ?? "Room",
        originalBox,
        newBox: boxToAssign,
      });
      setSelectedRoomId(roomId);
    } else {
      updateBox(roomId, boxToAssign);
      setSelectedRoomId(roomId);
      onHighlightRoom(roomId);
    }
  };

  // Esc leaves draw/freeform mode (a box in progress is cancelled by the draw layer first).
  useEffect(() => {
    if (!drawingBox && !drawingFreeform) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawMode(false);
        setFreeformMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawingBox, drawingFreeform]);

  const pdfPageCount = pdfInfo?.pageCount ?? 1;

  if (!drawing) {
    return (
      <div className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blueprint-light">
          <ImageIcon className="h-6 w-6 text-primary" />
        </div>
        <p className="text-sm font-medium text-foreground">No drawing on this floor yet</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Upload a floor plan and the detected rooms will appear here as overlays you can highlight.
        </p>
      </div>
    );
  }

  // Must stay shrink-wrapped to the media: its on-screen rect converts drag pixels to sheet units.
  const overlayLayer = (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0">
      {roomsWithBoxes.map(({ room, box }) => (
        <RoomOverlayBox
          key={room.id}
          room={room}
          box={box}
          color={roomColor ? roomColor(room) : roomTypeColor(room.room_type)}
          zoom={zoom}
          isHot={highlightedRoomId === room.id}
          isSelected={editing && selectedRoomId === room.id}
          isFreeformTarget={drawingFreeform && selectedRoomId === room.id}
          editMode={editing && !pendingShapeEdit}
          showLabel={showLabels}
          getLayerRect={getLayerRect}
          onHover={onHighlightRoom}
          onClickRoom={handleRoomClick}
          onSelect={setSelectedRoomId}
          onCommitBox={handleCommitBox}
          onRename={renameRoom}
          onStartFreeform={handleStartFreeform}
        />
      ))}

      {drawingBox && (
        <BoxDrawLayer zoom={zoom} getLayerRect={getLayerRect} onDrawn={handleBoxDrawn} />
      )}

      {drawingFreeform && (
        <FreeformDrawLayer
          zoom={zoom}
          getLayerRect={getLayerRect}
          targetRoom={selectedRoom}
          targetBox={selectedRoomBox}
          existingRooms={roomsWithBoxes}
          onSelectRoom={setSelectedRoomId}
          onDrawn={handleFreeformDrawn}
        />
      )}

      {editing && pendingBox && (
        <NewRoomPanel
          box={pendingBox}
          zoom={zoom}
          suggestions={nameSuggestions}
          unplacedRooms={unplacedRooms}
          placedRooms={placedRooms}
          saving={isCreating}
          onCreate={handleCreateRoom}
          onAssign={handleAssignBox}
          onCancel={cancelPendingBox}
        />
      )}

      {editing && pendingShapeEdit && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              top: `${pendingShapeEdit.originalBox[0] / 10}%`,
              left: `${pendingShapeEdit.originalBox[1] / 10}%`,
              height: `${(pendingShapeEdit.originalBox[2] - pendingShapeEdit.originalBox[0]) / 10}%`,
              width: `${(pendingShapeEdit.originalBox[3] - pendingShapeEdit.originalBox[1]) / 10}%`,
              border: `${2 / zoom}px dashed hsl(var(--muted-foreground) / 0.6)`,
              backgroundColor: "hsl(var(--muted-foreground) / 0.08)",
              borderRadius: 3,
              zIndex: 14,
            }}
          >
            <span
              className="absolute left-1 top-1 rounded bg-background/90 px-1 py-0.5 text-[9px] font-semibold text-muted-foreground shadow-sm"
              style={{ transform: `scale(${Math.max(0.65, 1 / zoom)})`, transformOrigin: "top left" }}
            >
              Previous shape
            </span>
          </div>

          <ShapeEditPrompt
            roomName={pendingShapeEdit.roomName}
            box={pendingShapeEdit.newBox}
            zoom={zoom}
            onSave={handleSaveShapeEdit}
            onUndo={handleUndoShapeEdit}
          />
        </>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`flex flex-col overflow-hidden border border-border bg-card ${
        isFullscreen ? "h-screen w-screen rounded-none" : "h-full rounded-xl"
      }`}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card/80 px-3 py-2">
        <div className="mr-1 flex min-w-0 items-center gap-2">
          {isPdf ? (
            <FileText className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <ImageIcon className="h-4 w-4 shrink-0 text-primary" />
          )}
          <span className="truncate text-xs font-medium text-foreground" title={drawing.file_name}>
            {drawing.file_name}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {/* Page nav (multi-page PDFs only) */}
          {isPdf && pdfPageCount > 1 && (
            <>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                disabled={pdfPage <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="w-12 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
                {pdfPage}/{pdfPageCount}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={() => setPdfPage((p) => Math.min(pdfPageCount, p + 1))}
                disabled={pdfPage >= pdfPageCount}
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <div className="mx-1 h-5 w-px bg-border" />
            </>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={showAnnotations ? "default" : "outline"}
                className="h-7 w-7"
                onClick={() => setShowAnnotations((v) => !v)}
                aria-label="Toggle AI annotations"
                aria-pressed={showAnnotations}
              >
                <SquareDashedMousePointer className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showAnnotations ? "Hide" : "Show"} AI room overlays</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={showLabels ? "default" : "outline"}
                className="h-7 w-7"
                onClick={() => setShowLabels((v) => !v)}
                disabled={!showAnnotations}
                aria-label="Toggle room labels"
                aria-pressed={showLabels}
              >
                <Tag className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showLabels ? "Hide" : "Show"} room labels</TooltipContent>
          </Tooltip>

          {!readOnly && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={editing ? "default" : "outline"}
                className="h-7 w-7"
                onClick={() => {
                  setEditMode((v) => !v);
                  setSelectedRoomId(null);
                  setDrawMode(false);
                  setFreeformMode(false);
                  setPendingBox(null);
                }}
                disabled={!onAnalysedSheet || !signedUrl}
                aria-label={editing ? "Finish editing room boxes" : "Edit room boxes"}
                aria-pressed={editing}
              >
                <PencilRuler className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editing ? "Done editing" : "Edit boxes: add, resize, move or rename rooms"}
            </TooltipContent>
          </Tooltip>
          )}

          {editing && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    ref={addButtonRef}
                    size="icon"
                    variant={drawMode && !freeformMode ? "default" : "outline"}
                    className="h-7 w-7"
                    onClick={(e) => {
                      if (pendingBox) return;
                      // Keyboard activation: drop a centred box.
                      if (e.detail === 0 && !drawMode) {
                        setSelectedRoomId(null);
                        setFreeformMode(false);
                        setPendingBox(centredBox());
                        return;
                      }
                      setSelectedRoomId(null);
                      setFreeformMode(false);
                      setDrawMode((v) => !v);
                    }}
                    disabled={!!pendingBox}
                    aria-label={drawMode && !freeformMode ? "Stop adding a box" : "Add a new room box (rectangle)"}
                    aria-pressed={drawMode && !freeformMode}
                  >
                    <SquarePlus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {drawMode && !freeformMode ? "Cancel rectangle draw" : "Rectangle draw: drag to draw a rectangular room box"}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant={freeformMode ? "default" : "outline"}
                    className="h-7 w-7"
                    onClick={() => {
                      if (pendingBox) return;
                      setDrawMode(false);
                      setFreeformMode((v) => !v);
                    }}
                    disabled={!!pendingBox}
                    aria-label={
                      freeformMode
                        ? "Stop freeform draw"
                        : selectedRoom
                        ? `Reshape ${selectedRoom.name} with freeform lasso`
                        : "Freeform draw: trace any shape"
                    }
                    aria-pressed={freeformMode}
                  >
                    <Lasso className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {freeformMode
                    ? "Cancel freeform mode"
                    : selectedRoom
                    ? `Reshape "${selectedRoom.name}" with freeform lasso`
                    : "Freeform lasso: draw any shape or click a room to reshape it"}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={!pendingShapeEdit && boxHistory.length === 0}
                    onClick={handleUndoLastChange}
                    aria-label="Undo shape change (Ctrl+Z)"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {pendingShapeEdit
                    ? `Undo pending changes for ${pendingShapeEdit.roomName} (Esc / Ctrl+Z)`
                    : boxHistory.length > 0
                    ? `Undo change to ${boxHistory[boxHistory.length - 1].roomName} (Ctrl+Z)`
                    : "Undo shape change (Ctrl+Z)"}
                </TooltipContent>
              </Tooltip>
            </>
          )}

          <div className="mx-1 h-5 w-px bg-border" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={() => setZoom((z) => clampZoom(z / 1.25))}
                aria-label="Zoom out"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom out</TooltipContent>
          </Tooltip>

          <span className="w-11 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={() => setZoom((z) => clampZoom(z * 1.25))}
                aria-label="Zoom in"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom in</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={resetView}
                aria-label="Reset view"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fit to view</TooltipContent>
          </Tooltip>

          <div className="mx-1 h-5 w-px bg-border" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={isFullscreen ? "default" : "outline"}
                className="h-7 w-7"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
                aria-pressed={isFullscreen}
              >
                {isFullscreen ? (
                  <Shrink className="h-3.5 w-3.5" />
                ) : (
                  <Expand className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isFullscreen ? "Exit full screen" : "Full screen"}</TooltipContent>
          </Tooltip>

          {isPdf && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="icon" variant="outline" className="h-7 w-7">
                  <a
                    href={signedUrl ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open original PDF in a new tab"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open original PDF in a new tab</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        onMouseDown={startPan}
        className={`blueprint-grid relative flex-1 overflow-hidden bg-muted/30 ${
          isPanning ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{ minHeight: 460 }}
      >
        {urlLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : !signedUrl ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Could not load this drawing from storage.
            </p>
          </div>
        ) : (
          <div
            className="absolute left-1/2 top-1/2 origin-center"
            style={{
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`,
              transition: isPanning ? "none" : "transform 120ms ease-out",
            }}
          >
            {/* Wrapper shrink-wraps the media so bbox percentages line up. */}
            <div className="relative inline-block">
              {isPdf ? (
                <PdfCanvas
                  url={signedUrl}
                  page={pdfPage}
                  renderWidth={pdfRenderWidth}
                  onRendered={handleRendered}
                />
              ) : (
                <img
                  src={signedUrl}
                  alt={`Architectural drawing: ${drawing.file_name}`}
                  className="block select-none"
                  style={{ maxWidth: fitWidth, maxHeight: fitHeight, width: "auto", height: "auto" }}
                  draggable={false}
                />
              )}

              {onAnalysedSheet && overlayLayer}
            </div>
          </div>
        )}

        {/* Status chip */}
        {showAnnotations && signedUrl && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-card/90 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground shadow-card backdrop-blur-sm">
            {isPdf && pdfPage !== 1 ? (
              "Highlights are shown on sheet 1"
            ) : editing ? (
              <span aria-live="polite">
                <span className="font-semibold text-primary">
                  {pendingShapeEdit
                    ? "Review shape changes"
                    : pendingBox
                    ? "New room"
                    : drawingFreeform
                    ? selectedRoom
                      ? `Reshaping ${selectedRoom.name}`
                      : "Freeform lasso"
                    : drawingBox
                    ? "Adding a box"
                    : "Editing"}
                </span>
                <span className="mx-1.5">·</span>
                {pendingShapeEdit
                  ? `Save or undo shape changes for "${pendingShapeEdit.roomName}" · Enter to save, Esc to undo`
                  : pendingBox
                  ? "Name the space to add it to the schedule"
                  : drawingFreeform
                  ? selectedRoom
                    ? `Trace new boundaries for "${selectedRoom.name}" · Click outside to draw a new room · Esc to cancel`
                    : "Draw freely to create a room, or click an existing room to reshape it · Esc to cancel"
                  : drawingBox
                  ? "Drag on the drawing to draw the new room · Esc to cancel"
                  : "Drag to move · handles to resize · double-click to rename · + or lasso to add/reshape"}
                {(isSaving || isCreating) && (
                  <span className="ml-1.5 text-foreground">· Saving…</span>
                )}
              </span>
            ) : roomsWithBoxes.length > 0 ? (
              <>
                {roomsWithBoxes.length} of {rooms.length} room
                {rooms.length === 1 ? "" : "s"} highlighted
                <span className="ml-1.5 rounded bg-primary/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-primary">
                  AI
                </span>
              </>
            ) : (
              "No room coordinates for this drawing"
            )}
          </div>
        )}
      </div>
    </div>
  );
}
