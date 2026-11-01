import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Building2,
  LogOut,
  FileSpreadsheet,
  FileText,
  PanelRightClose,
  PanelRightOpen,
  Menu,
  Table2,
  LayoutGrid,
  ClipboardList,
  Layers,
  Sparkles,
  Download,
  MapPinned,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import DrawingUploader from "@/components/DrawingUploader";
import RoomTable from "@/components/RoomTable";
import RoomWiseView from "@/components/RoomWiseView";
import FloorSidebar from "@/components/FloorSidebar";
import DrawingViewer from "@/components/DrawingViewer";
import AIRecommendationsPanel from "@/components/AIRecommendationsPanel";
import FloorSchedulePanel from "@/components/FloorSchedulePanel";
import { useFloors } from "@/hooks/useFloors";
import { useRecommendations } from "@/hooks/useRecommendations";
import {
  exportToExcel,
  exportToPDF,
  exportFloorToExcel,
  exportFloorToPDF,
  exportProjectToExcel,
  exportProjectToPDF,
} from "@/lib/exportUtils";
import { errorMessage, type Drawing, type Room } from "@/lib/types";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  /** null = the combined whole-project view. */
  const [projectView, setProjectView] = useState(false);
  const [highlightedRoomId, setHighlightedRoomId] = useState<string | null>(null);
  // Closed by default so the drawing gets the room; the header toggle opens it.
  const [insightsOpen, setInsightsOpen] = useState(false);
  /** Room whose schedule card is expanded (opened from the drawing or the card). */
  const [openedRoomId, setOpenedRoomId] = useState<string | null>(null);
  const toggleOpenedRoom = (roomId: string) =>
    setOpenedRoomId((current) => (current === roomId ? null : roomId));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  /** Room-wise cards (default, cleaner) vs the full Excel-style table. */
  const [scheduleView, setScheduleView] = useState<"cards" | "table">("cards");

  const {
    floors,
    isLoading: floorsLoading,
    activeFloor,
    activeFloorId,
    setActiveFloorId,
    addFloor,
    renameFloor,
    deleteFloor,
    ensureDefaultFloor,
  } = useFloors(id);

  const { data: project } = useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });

  const { data: drawings = [], isLoading: drawingsLoading } = useQuery({
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

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .eq("project_id", id!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as Room[];
    },
  });

  // A project with no floors can't accept a drawing, so make one on arrival.
  useEffect(() => {
    if (!floorsLoading && floors.length === 0 && id && !ensureDefaultFloor.isPending) {
      ensureDefaultFloor.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorsLoading, floors.length, id]);

  const effectiveFloorId = projectView ? null : activeFloorId;

  const {
    recommendations,
    isLoading: recsLoading,
    generate,
    accept,
    reject,
    resetToPending,
  } = useRecommendations(id, effectiveFloorId);

  // ---- Scoping: everything below respects the active floor (or whole project) --

  const floorDrawings = useMemo(
    () => (projectView ? drawings : drawings.filter((d) => d.floor_id === activeFloorId)),
    [drawings, projectView, activeFloorId]
  );

  const floorRooms = useMemo(
    () => (projectView ? rooms : rooms.filter((r) => r.floor_id === activeFloorId)),
    [rooms, projectView, activeFloorId]
  );

  /** Newest drawing on this floor drives the viewer. */
  const activeDrawing = useMemo(() => floorDrawings[0] ?? null, [floorDrawings]);

  /** Rooms belonging to the drawing currently shown, for the overlays. */
  const viewerRooms = useMemo(
    () => (activeDrawing ? floorRooms.filter((r) => r.drawing_id === activeDrawing.id) : []),
    [floorRooms, activeDrawing]
  );

  const countsByFloor = useMemo(() => {
    const counts: Record<string, { rooms: number; drawings: number }> = {};
    floors.forEach((f) => {
      counts[f.id] = {
        rooms: rooms.filter((r) => r.floor_id === f.id).length,
        drawings: drawings.filter((d) => d.floor_id === f.id).length,
      };
    });
    return counts;
  }, [floors, rooms, drawings]);

  /**
   * Floor-wise sections for the combined project view and exports.
   * Left un-annotated so the rooms keep the full app Room type (the export
   * helpers accept a structurally narrower shape).
   */
  const floorSections = useMemo(
    () =>
      floors.map((f) => ({
        floorName: f.name,
        rooms: rooms.filter((r) => r.floor_id === f.id),
      })),
    [floors, rooms]
  );

  const deleteDrawing = useMutation({
    mutationFn: async (drawingId: string) => {
      const drawing = drawings.find((d) => d.id === drawingId);
      if (drawing) {
        await supabase.storage.from("drawings").remove([drawing.storage_path]);
      }
      const { error } = await supabase.from("drawings").delete().eq("id", drawingId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drawings", id] });
      queryClient.invalidateQueries({ queryKey: ["rooms", id] });
      queryClient.invalidateQueries({ queryKey: ["recommendations", id] });
      toast({ title: "Drawing deleted" });
    },
  });

  const projectName = project?.name ?? "Project";
  const scopeLabel = projectView ? "Whole Project" : activeFloor?.name ?? "—";

  const handleSelectFloor = (floorId: string) => {
    setProjectView(false);
    setActiveFloorId(floorId);
    setHighlightedRoomId(null);
    setOpenedRoomId(null);
    setMobileSidebarOpen(false);
  };

  const handleShowProjectView = () => {
    setProjectView(true);
    setHighlightedRoomId(null);
    setOpenedRoomId(null);
    setMobileSidebarOpen(false);
  };

  // Excel/PDF exports default to the ENTIRE project (every floor). The Excel
  // workbook follows the practice's SOF template: one sheet with a lettered
  // section per floor. The PDF has one page per floor plus a summary.
  const totalProjectRooms = rooms.length;

  /** Excel export loads the template asynchronously, so surface failures. */
  const runExcelExport = (task: () => Promise<void>) => {
    task().catch((err: unknown) =>
      toast({ title: "Excel export failed", description: errorMessage(err), variant: "destructive" })
    );
  };

  const handleExportExcel = () =>
    runExcelExport(() => exportProjectToExcel(floorSections, projectName));
  const handleExportPDF = () => exportProjectToPDF(floorSections, projectName);

  const handleExportFloorExcel = () =>
    runExcelExport(() =>
      activeFloor
        ? exportFloorToExcel(floorRooms, projectName, activeFloor.name)
        : exportToExcel(floorRooms, projectName)
    );
  const handleExportFloorPDF = () => {
    if (activeFloor) exportFloorToPDF(floorRooms, projectName, activeFloor.name);
    else exportToPDF(floorRooms, projectName);
  };

  const pendingRecCount = recommendations.filter((r) => r.status === "pending").length;

  /**
   * Export dropdown. Primary action = the whole project (all floors); a
   * secondary item exports just the current floor when one is open.
   */
  const exportMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={totalProjectRooms === 0}
        >
          <Download className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs">
          Entire project · all {floors.length} floor{floors.length === 1 ? "" : "s"}
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={handleExportExcel} className="gap-2">
          <FileSpreadsheet className="h-4 w-4 text-success" />
          Excel workbook (all floors)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleExportPDF} className="gap-2">
          <FileText className="h-4 w-4 text-destructive" />
          PDF (all floors)
        </DropdownMenuItem>

        {!projectView && activeFloor && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">
              Current floor · {activeFloor.name}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={handleExportFloorExcel}
              disabled={floorRooms.length === 0}
              className="gap-2"
            >
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              Excel — this floor only
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleExportFloorPDF}
              disabled={floorRooms.length === 0}
              className="gap-2"
            >
              <FileText className="h-4 w-4 text-muted-foreground" />
              PDF — this floor only
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /** Cards vs Table switch, shared by the floor and whole-project schedule views. */
  const viewToggle = (
    <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
      <button
        onClick={() => setScheduleView("cards")}
        aria-pressed={scheduleView === "cards"}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
          scheduleView === "cards"
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Room-wise
      </button>
      <button
        onClick={() => setScheduleView("table")}
        aria-pressed={scheduleView === "table"}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
          scheduleView === "table"
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Table2 className="h-3.5 w-3.5" />
        Full table
      </button>
    </div>
  );

  /** Rendered in both the desktop column and the mobile sheet. */
  const insightsPanel = (
    <AIRecommendationsPanel
      rooms={floorRooms}
      recommendations={recommendations}
      isLoading={recsLoading}
      isGenerating={generate.isPending}
      highlightedRoomId={highlightedRoomId}
      onHighlightRoom={setHighlightedRoomId}
      canGenerate={!projectView}
      onGenerate={() =>
        generate.mutate({
          rooms: floorRooms,
          projectId: id!,
          floorId: activeFloorId,
          projectName,
          floorName: activeFloor?.name,
        })
      }
      onAccept={(rec, finishOverride, tier) =>
        accept.mutate({ recommendation: rec, finishOverride, tier })
      }
      onReject={(recId) => reject.mutate(recId)}
      onReopen={(recId) => resetToPending.mutate(recId)}
    />
  );

  const sidebar = (
    <FloorSidebar
      floors={floors}
      activeFloorId={activeFloorId}
      countsByFloor={countsByFloor}
      isLoading={floorsLoading}
      projectViewActive={projectView}
      onSelectFloor={handleSelectFloor}
      onShowProjectView={handleShowProjectView}
      onAddFloor={() => addFloor.mutate(undefined)}
      onRenameFloor={(floorId, name) => renameFloor.mutate({ id: floorId, name })}
      onDeleteFloor={(floorId) => deleteFloor.mutate(floorId)}
      isAddingFloor={addFloor.isPending}
    />
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="z-40 shrink-0 border-b border-border bg-card">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Open floor navigation"
          >
            <Menu className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/dashboard")}
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-primary">
            <Building2 className="h-4 w-4 text-primary-foreground" />
          </div>

          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold font-heading leading-tight text-foreground">
              {projectName}
            </h1>
            <p className="flex items-center gap-1 text-[11px] leading-tight text-muted-foreground">
              <Layers className="h-2.5 w-2.5" />
              {scopeLabel}
              <span className="mx-0.5">·</span>
              {floorRooms.length} room{floorRooms.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => navigate(`/project/${id}/recommendations`)}
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="hidden sm:inline">AI Recommendations</span>
              {pendingRecCount > 0 && (
                <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                  {pendingRecCount}
                </span>
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => navigate(`/project/${id}/legend-mapping`)}
            >
              <MapPinned className="h-3.5 w-3.5 text-primary" />
              <span className="hidden sm:inline">Legend Mapping</span>
            </Button>

            <div className="mx-0.5 hidden h-6 w-px bg-border sm:block" />

            {exportMenu}

            <Button
              variant="ghost"
              size="icon"
              className="hidden xl:inline-flex"
              onClick={() => setInsightsOpen((v) => !v)}
              aria-label={insightsOpen ? "Hide AI insights" : "Show AI insights"}
              aria-pressed={insightsOpen}
            >
              {insightsOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>

            <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
            <span className="hidden max-w-[160px] truncate text-xs text-muted-foreground lg:block">
              {user?.email}
            </span>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Body: sidebar | main | insights */}
      <div className="flex min-h-0 flex-1">
        {/* Floor sidebar (desktop) */}
        <div className="hidden w-60 shrink-0 lg:block">{sidebar}</div>

        {/* Floor sidebar (mobile drawer) */}
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" className="w-64 p-0">
            <SheetTitle className="sr-only">Floor navigation</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>

        {/* Main workspace */}
        <main
          className={`min-w-0 flex-1 ${projectView ? "overflow-y-auto" : "overflow-y-auto lg:overflow-hidden"}`}
        >
          <div className={projectView ? "space-y-5 p-4 sm:p-5" : "h-full"}>
            {projectView ? (
              /* ---------------- Combined project view ---------------- */
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold font-heading text-foreground">
                      Project Schedule of Finishes
                    </h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      All {floors.length} floor{floors.length === 1 ? "" : "s"} combined ·{" "}
                      {rooms.length} room{rooms.length === 1 ? "" : "s"} total
                    </p>
                  </div>
                  {viewToggle}
                </div>

                {floorSections.every((s) => s.rooms.length === 0) ? (
                  <div className="rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center">
                    <ClipboardList className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">No rooms detected yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Open a floor and upload a drawing to build the schedule.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {floorSections.map((section) => (
                      <div key={section.floorName}>
                        {section.rooms.length === 0 ? (
                          <div className="rounded-xl border border-border bg-card px-4 py-3">
                            <p className="text-sm font-semibold font-heading text-foreground">
                              {section.floorName}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              No rooms detected on this floor yet.
                            </p>
                          </div>
                        ) : scheduleView === "cards" ? (
                          <RoomWiseView
                            rooms={section.rooms}
                            projectId={id!}
                            groupLabel={section.floorName}
                            highlightedRoomId={highlightedRoomId}
                            onHighlightRoom={setHighlightedRoomId}
                          />
                        ) : (
                          <RoomTable
                            rooms={section.rooms}
                            projectId={id!}
                            groupLabel={section.floorName}
                            highlightedRoomId={highlightedRoomId}
                            onHighlightRoom={setHighlightedRoomId}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              /* ---------------- Single floor workspace ----------------
                 Drawing fills the left; the schedule cards sit on the right.
                 Clicking a room on the drawing opens its card. */
              <div className="flex h-full flex-col lg:flex-row">
                <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4 lg:min-h-0 lg:flex-1">
                  <DrawingUploader
                    projectId={id!}
                    floorId={activeFloorId}
                    floorName={activeFloor?.name ?? ""}
                  />
                  <div className="h-[75vh] min-h-[460px] lg:h-auto lg:min-h-0 lg:flex-1">
                    <DrawingViewer
                      drawing={activeDrawing}
                      rooms={viewerRooms}
                      highlightedRoomId={highlightedRoomId ?? openedRoomId}
                      onHighlightRoom={setHighlightedRoomId}
                      onRoomClick={toggleOpenedRoom}
                      floorName={activeFloor?.name}
                    />
                  </div>
                </div>

                <aside
                  aria-label="Schedule of Finishes"
                  className="flex min-h-[480px] flex-col border-t border-border bg-card lg:min-h-0 lg:w-[380px] lg:shrink-0 lg:border-l lg:border-t-0"
                >
                  <FloorSchedulePanel
                    projectId={id!}
                    floorName={activeFloor?.name ?? ""}
                    rooms={floorRooms}
                    drawings={floorDrawings}
                    drawingsLoading={drawingsLoading}
                    highlightedRoomId={highlightedRoomId ?? openedRoomId}
                    onHighlightRoom={setHighlightedRoomId}
                    openedRoomId={openedRoomId}
                    onToggleRoom={toggleOpenedRoom}
                    onDeleteDrawing={(drawingId) => deleteDrawing.mutate(drawingId)}
                  />
                </aside>
              </div>
            )}
          </div>
        </main>
        {/* AI insights panel (desktop) */}
        {insightsOpen && (
          <div className="hidden w-80 shrink-0 xl:block">{insightsPanel}</div>
        )}
      </div>

      {/* AI insights trigger for narrow screens */}
      <div className="fixed bottom-4 right-4 xl:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              size="sm"
              className="gap-2 rounded-full shadow-elevated gradient-primary text-primary-foreground"
            >
              <Sparkles className="h-4 w-4" />
              AI Insights
              {pendingRecCount > 0 && (
                <span className="ml-0.5 rounded-full bg-primary-foreground/20 px-1.5 text-[10px] font-semibold">
                  {pendingRecCount}
                </span>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[min(22rem,92vw)] p-0">
            <SheetTitle className="sr-only">AI insights</SheetTitle>
            {insightsPanel}
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
