import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { AuditLogEntryDto, EquipmentDto, SessionSnapshotDto, SessionState } from "@crop/shared";
import { api } from "../lib/api-client.js";
import { useAuthenticatedImage } from "../hooks/use-authenticated-image.js";
import { Button } from "../components/ui/button.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";

const NEARBY_WINDOW_MS = 8000;

function summarizeAuditEntry(entry: AuditLogEntryDto): string {
  if (entry.action === "INPUT_BATCH") {
    const events = (entry.details as { events?: unknown[] })?.events ?? [];
    return `${events.length} input event(s)`;
  }
  if (entry.action === "PRINT_TEXT") {
    const details = entry.details as { length?: number };
    return `typed text (${details.length ?? "?"} chars)`;
  }
  return entry.action;
}

export default function SessionReplayPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [session, setSession] = useState<SessionState | null>(null);
  const [equipment, setEquipment] = useState<EquipmentDto | null>(null);
  const [snapshots, setSnapshots] = useState<SessionSnapshotDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntryDto[] | null>(null); // null = not authorized to view, not "empty"
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const s = await api.get<SessionState>(`/sessions/${sessionId}`);
        const [eq, snaps] = await Promise.all([
          api.get<EquipmentDto>(`/equipment/${s.equipmentId}`),
          api.get<SessionSnapshotDto[]>(`/sessions/${sessionId}/snapshots`),
        ]);
        setSession(s);
        setEquipment(eq);
        setSnapshots(snaps);
        setIndex(Math.max(0, snaps.length - 1));

        // Only AUDITOR/OPERATIONAL_SUPERVISOR/LOCAL_SUPERVISOR/CLINIC_ADMIN/OPERATOR_ADMIN/
        // PLATFORM_ADMIN can list audit logs (see AuditController's @Roles) -- an OPERATOR
        // viewing their own session's replay simply won't see this panel, which is the
        // correct behaviour, not an error to surface.
        try {
          setAuditLogs(await api.get<AuditLogEntryDto[]>(`/audit?sessionId=${sessionId}&limit=500`));
        } catch {
          setAuditLogs(null);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Could not load this session's replay.");
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  const current = snapshots[index] ?? null;
  const imageUrl = useAuthenticatedImage(
    sessionId && current ? `/sessions/${sessionId}/snapshots/${current.id}/image` : null
  );

  const nearbyEvents = useMemo(() => {
    if (!auditLogs || !current) return [];
    const t = new Date(current.capturedAt).getTime();
    return auditLogs
      .filter((log) => Math.abs(new Date(log.timestamp).getTime() - t) <= NEARBY_WINDOW_MS)
      .filter((log) => log.action !== "SNAPSHOT_CAPTURED") // the snapshot itself, not interesting to list against itself
      .sort((a, b) => a.seq - b.seq);
  }, [auditLogs, current]);

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-start gap-3 bg-background p-5 text-foreground">
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          Back
        </Button>
      </main>
    );
  }

  if (loading || !session || !equipment) {
    return (
      <main className="min-h-screen bg-background p-5 text-foreground" aria-live="polite">
        Loading replay...
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-5 py-3.5">
        <strong>{equipment.name} — Replay</strong>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          Back
        </Button>
      </header>

      <main className="p-5">
        <h1 className="sr-only">{equipment.name} session replay</h1>
        {snapshots.length === 0 ? (
          <p className="text-muted-foreground">
            No snapshots were captured for this session (it may have been too short, or ended before the first
            capture interval elapsed).
          </p>
        ) : (
          <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)] items-start gap-4">
            <div>
              {/* Stays black regardless of the app's own theme -- a real video surface, not
                  page chrome, same "shared ancestor" reasoning as `SessionPage`'s own console
                  box (see docs/architecture.md). Unlike that one, this is a static `<img>`
                  snapshot, not a live canvas -- no HID coordinate math depends on its sizing,
                  but `w-full block` is kept anyway for the identical letterboxing-free layout. */}
              <div className="relative mb-4 overflow-hidden rounded-lg bg-black">
                {imageUrl ? (
                  <img src={imageUrl} alt={`Console at ${current?.capturedAt}`} className="block w-full" />
                ) : (
                  <div className="aspect-video" />
                )}
                <div className="absolute top-2 left-2 rounded-md bg-black/60 px-2.5 py-1.5 font-mono text-xs text-white">
                  {current ? new Date(current.capturedAt).toLocaleTimeString() : ""}
                </div>
              </div>

              <Card>
                <CardContent>
                  <label htmlFor="replay-scrubber" className="sr-only">
                    Snapshot timeline scrubber, frame {index + 1} of {snapshots.length}
                  </label>
                  <input
                    id="replay-scrubber"
                    type="range"
                    min={0}
                    max={Math.max(0, snapshots.length - 1)}
                    value={index}
                    onChange={(e) => setIndex(Number(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{new Date(snapshots[0]!.capturedAt).toLocaleTimeString()}</span>
                    <span>
                      Frame {index + 1} of {snapshots.length}
                    </span>
                    <span>{new Date(snapshots[snapshots.length - 1]!.capturedAt).toLocaleTimeString()}</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-[1.1em]">Activity within {NEARBY_WINDOW_MS / 1000}s of this frame</CardTitle>
              </CardHeader>
              <CardContent>
                {auditLogs === null ? (
                  <p className="text-[13px] text-muted-foreground">
                    Your role does not have access to the audit trail. Snapshot playback is still available above.
                  </p>
                ) : nearbyEvents.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No recorded activity in this window.</p>
                ) : (
                  <ul className="pl-4.5 text-[13px]">
                    {nearbyEvents.map((entry) => (
                      <li key={entry.id}>
                        {new Date(entry.timestamp).toLocaleTimeString()} — {summarizeAuditEntry(entry)}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
