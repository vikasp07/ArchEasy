import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  DoorOpen,
  Layers,
  ChevronRight,
  Grid2x2,
  PaintBucket,
  Pencil,
  Trash2,
  Maximize2,
  StickyNote,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import RoomDetailDialog from "@/components/RoomDetailDialog";
import RoomEditDialog from "@/components/RoomEditDialog";
import {
  roomTypeLabel,
  finishSummary,
  ROOM_FIELD_GROUPS,
  fieldValue,
  groupHasData,
  EMPTY_VALUE,
} from "@/lib/roomFields";
import type { Room } from "@/lib/types";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Props {
  rooms: Room[];
  projectId: string;
  highlightedRoomId?: string | null;
  onHighlightRoom?: (id: string | null) => void;
  /** Optional grouping banner (used in the whole-project view). */
  groupLabel?: string;
  /** "grid" = responsive card grid; "list" = single column for a side panel. */
  variant?: "grid" | "list";
  /**
   * Card that is expanded in place to show every finish. When `onToggleRoom`
   * is given, clicking a card expands it instead of opening the detail dialog.
   */
  expandedRoomId?: string | null;
  onToggleRoom?: (id: string) => void;
}

/** Colour chip per room type so the grid scans quickly. */
function typeAccent(roomType: string | null): string {
  switch (roomType) {
    case "bathroom":
      return "bg-sky-500/10 text-sky-600 border-sky-500/20";
    case "kitchen":
      return "bg-orange-500/10 text-orange-600 border-orange-500/20";
    case "bedroom":
      return "bg-violet-500/10 text-violet-600 border-violet-500/20";
    case "living":
    case "dining":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
    case "lobby":
    case "hallway":
      return "bg-primary/10 text-primary border-primary/20";
    case "staircase":
      return "bg-pink-500/10 text-pink-600 border-pink-500/20";
    case "utility":
    case "service":
    case "storage":
      return "bg-muted text-muted-foreground border-border";
    case "parking":
    case "garage":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20";
    default:
      return "bg-primary/10 text-primary border-primary/20";
  }
}

/** Every SOF field of a room, shown inside an expanded card. */
function RoomFinishDetails({ room }: { room: Room }) {
  const groups = ROOM_FIELD_GROUPS.filter((g) => groupHasData(room, g));
  return (
    <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
      {groups.length === 0 && (
        <p className="text-xs text-muted-foreground">No finishes recorded for this room yet.</p>
      )}
      {groups.map((group) => (
        <section key={group.title}>
          <h4 className={`mb-1 text-[10px] font-bold uppercase tracking-wide ${group.accent}`}>
            {group.title}
          </h4>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {group.fields
              .filter((f) => fieldValue(room, f.key) !== EMPTY_VALUE)
              .map((field) => (
                <div key={String(field.key)} className="min-w-0">
                  <dt className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd className="break-words text-xs text-foreground">{fieldValue(room, field.key)}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
      {room.remark && (
        <section className="rounded-md bg-muted/40 p-2">
          <h4 className="mb-0.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            <StickyNote className="h-3 w-3" aria-hidden="true" />
            Remark
          </h4>
          <p className="text-xs leading-relaxed text-foreground/90">{room.remark}</p>
        </section>
      )}
    </div>
  );
}

export default function RoomWiseView({
  rooms,
  projectId,
  highlightedRoomId,
  onHighlightRoom,
  groupLabel,
  variant = "grid",
  expandedRoomId = null,
  onToggleRoom,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Room | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editRoom, setEditRoom] = useState<Room | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // A room opened from the drawing scrolls its card into view.
  useEffect(() => {
    if (!expandedRoomId) return;
    const el = cardRefs.current.get(expandedRoomId);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [expandedRoomId]);

  const openRoom = (room: Room) => {
    setSelected(room);
    setDialogOpen(true);
  };

  const handleCardClick = (room: Room) => {
    if (onToggleRoom) onToggleRoom(room.id);
    else openRoom(room);
  };

  const openEdit = (room: Room) => {
    setEditRoom(room);
    setEditOpen(true);
  };

  const deleteRoom = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("rooms").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", projectId] });
      toast({ title: "Room deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const handleDelete = (id: string) => {
    if (confirm("Delete this room? This cannot be undone.")) {
      deleteRoom.mutate(id);
    }
  };

  const isList = variant === "list";

  return (
    <div>
      {groupLabel && (
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-sm font-semibold font-heading text-foreground">{groupLabel}</h3>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {rooms.length} room{rooms.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      <div className={isList ? "space-y-2" : "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"}>
        {rooms.map((room, idx) => {
          const isHot = highlightedRoomId === room.id;
          const isOpen = expandedRoomId === room.id;
          return (
            <motion.div
              key={room.id}
              ref={(el) => {
                if (el) cardRefs.current.set(room.id, el);
                else cardRefs.current.delete(room.id);
              }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx * 0.02, 0.3) }}
              onMouseEnter={() => onHighlightRoom?.(room.id)}
              onMouseLeave={() => onHighlightRoom?.(null)}
              className={`group flex flex-col rounded-xl border bg-card shadow-card transition-all hover:shadow-elevated ${
                isList ? "p-3" : "p-4"
              } ${
                isOpen
                  ? "border-primary/60 ring-2 ring-primary/20"
                  : isHot
                    ? "border-primary/40 ring-1 ring-primary/20"
                    : "border-border"
              }`}
            >
              <button
                type="button"
                onClick={() => handleCardClick(room)}
                aria-expanded={onToggleRoom ? isOpen : undefined}
                className="flex flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
              >
                <div className="flex items-start gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blueprint-light">
                    <DoorOpen className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground" title={room.name}>
                      {room.name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className={`text-[9px] ${typeAccent(room.room_type)}`}>
                        {roomTypeLabel(room.room_type)}
                      </Badge>
                      {room.space_tag && (
                        <span className="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground">
                          {room.space_tag}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? "rotate-90" : "group-hover:translate-x-0.5"
                    }`}
                    aria-hidden="true"
                  />
                </div>

                {!isOpen && (
                  <>
                    <div className="mt-3 space-y-1.5 text-xs">
                      <div className="flex items-start gap-1.5">
                        <Grid2x2 className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          Floor: <span className="text-foreground">{room.floor_finish?.trim() || "—"}</span>
                        </span>
                      </div>
                      <div className="flex items-start gap-1.5">
                        <PaintBucket className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          Ceiling: <span className="text-foreground">{room.ceiling_finish?.trim() || "—"}</span>
                        </span>
                      </div>
                      {room.floor_level && !isList && (
                        <div className="flex items-start gap-1.5">
                          <Layers className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">{room.floor_level}</span>
                        </div>
                      )}
                    </div>
                    <p className="mt-3 line-clamp-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                      {finishSummary(room)}
                    </p>
                  </>
                )}
              </button>

              {isOpen && <RoomFinishDetails room={room} />}

              {/* Actions: always shown on an open card, on hover otherwise */}
              <div
                className={`mt-2 flex gap-1 transition-opacity ${
                  isOpen ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
                }`}
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-[10px]"
                  onClick={() => openEdit(room)}
                >
                  <Pencil className="h-2.5 w-2.5" />
                  Edit
                </Button>
                {onToggleRoom && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => openRoom(room)}
                  >
                    <Maximize2 className="h-2.5 w-2.5" />
                    Full view
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(room.id)}
                  disabled={deleteRoom.isPending}
                >
                  <Trash2 className="h-2.5 w-2.5" />
                  Delete
                </Button>
              </div>
            </motion.div>
          );
        })}
      </div>

      <RoomDetailDialog
        room={selected}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
      />
      <RoomEditDialog
        room={editRoom}
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
      />
    </div>
  );
}
