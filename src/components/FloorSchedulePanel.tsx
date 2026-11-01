/**
 * Right-hand schedule panel for a floor: room cards (single column) and the
 * floor's drawings. A room clicked on the drawing expands here and scrolls
 * into view; the full Excel-style table opens in a wide side sheet.
 */
import { ClipboardList, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import RoomWiseView from "@/components/RoomWiseView";
import RoomTable from "@/components/RoomTable";
import DrawingCard from "@/components/DrawingCard";
import DetectionSummary from "@/components/DetectionSummary";
import type { Drawing, Room } from "@/lib/types";

interface Props {
  projectId: string;
  floorName: string;
  rooms: Room[];
  drawings: Drawing[];
  drawingsLoading: boolean;
  highlightedRoomId: string | null;
  onHighlightRoom: (id: string | null) => void;
  openedRoomId: string | null;
  onToggleRoom: (id: string) => void;
  onDeleteDrawing: (id: string) => void;
}

export default function FloorSchedulePanel({
  projectId,
  floorName,
  rooms,
  drawings,
  drawingsLoading,
  highlightedRoomId,
  onHighlightRoom,
  openedRoomId,
  onToggleRoom,
  onDeleteDrawing,
}: Props) {
  return (
    <Tabs defaultValue="schedule" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <TabsList className="h-8">
          <TabsTrigger value="schedule" className="gap-1.5 px-2.5 text-xs">
            <ClipboardList className="h-3.5 w-3.5" />
            Rooms ({rooms.length})
          </TabsTrigger>
          <TabsTrigger value="drawings" className="gap-1.5 px-2.5 text-xs">
            Drawings ({drawings.length})
          </TabsTrigger>
        </TabsList>

        <Sheet>
          <SheetTrigger asChild>
            <Button size="sm" variant="outline" className="ml-auto h-8 gap-1.5 text-xs" disabled={rooms.length === 0}>
              <Table2 className="h-3.5 w-3.5" />
              Full table
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[96vw] overflow-y-auto sm:max-w-[96vw]">
            <SheetTitle className="mb-1 pr-8">Schedule of Finishes · {floorName}</SheetTitle>
            <p className="mb-4 text-xs text-muted-foreground">Editable — matches the Excel export.</p>
            <RoomTable
              rooms={rooms}
              projectId={projectId}
              highlightedRoomId={highlightedRoomId}
              onHighlightRoom={onHighlightRoom}
            />
          </SheetContent>
        </Sheet>
      </div>

      <TabsContent value="schedule" className="mt-0 min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {rooms.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
            <ClipboardList className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No rooms on {floorName || "this floor"} yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload a drawing and the AI will extract every labelled space.
            </p>
          </div>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground">
              Click a room on the drawing or a card here to open its finish details.
            </p>
            <RoomWiseView
              rooms={rooms}
              projectId={projectId}
              variant="list"
              highlightedRoomId={highlightedRoomId}
              onHighlightRoom={onHighlightRoom}
              expandedRoomId={openedRoomId}
              onToggleRoom={onToggleRoom}
            />
          </>
        )}
        <DetectionSummary drawings={drawings} rooms={rooms} />
      </TabsContent>

      <TabsContent value="drawings" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3">
        {drawingsLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : drawings.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No drawings on this floor yet.</p>
        ) : (
          <div className="space-y-3">
            {drawings.map((drawing) => (
              <DrawingCard key={drawing.id} drawing={drawing} onDelete={() => onDeleteDrawing(drawing.id)} />
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
