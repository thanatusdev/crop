import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PIKVM_KEYMAPS, DEFAULT_KEYMAP, type EquipmentDto, type TargetOs } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";

const TARGET_OS_OPTIONS: TargetOs[] = ["WINDOWS", "MACOS", "LINUX"] as TargetOs[];

interface EditState {
  name: string;
  pikvmHost: string;
  pikvmUser: string;
  pikvmPassword: string;
  targetOs: TargetOs;
  keymap: string;
  screenWidth: number;
  screenHeight: number;
  cameraUrl: string;
}

function editStateFor(eq: EquipmentDto): EditState {
  return {
    name: eq.name,
    pikvmHost: eq.pikvmHost,
    pikvmUser: eq.pikvmUser,
    pikvmPassword: "",
    targetOs: eq.targetOs,
    keymap: eq.keymap,
    screenWidth: eq.screenWidth,
    screenHeight: eq.screenHeight,
    cameraUrl: eq.cameraUrl ?? "",
  };
}

export default function AdminEquipmentPage() {
  const navigate = useNavigate();

  const [equipment, setEquipment] = useState<EquipmentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [pikvmHost, setPikvmHost] = useState("");
  const [pikvmUser, setPikvmUser] = useState("admin");
  const [pikvmPassword, setPikvmPassword] = useState("");
  const [targetOs, setTargetOs] = useState<TargetOs>(TARGET_OS_OPTIONS[0]!);
  const [keymap, setKeymap] = useState<string>(DEFAULT_KEYMAP);
  const [screenWidth, setScreenWidth] = useState(1920);
  const [screenHeight, setScreenHeight] = useState(1080);
  const [cameraUrl, setCameraUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<EquipmentDto | null>(null);

  // Edit -- which row (if any) has its inline edit form open.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [maintenanceActionId, setMaintenanceActionId] = useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setEquipment(await api.get<EquipmentDto[]>("/equipment"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load equipment.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const created = await api.post<EquipmentDto>("/equipment", {
        name,
        pikvmHost,
        pikvmUser,
        pikvmPassword,
        targetOs,
        keymap,
        screenWidth,
        screenHeight,
        cameraUrl: cameraUrl || undefined,
      });
      setCreated(created);
      setName("");
      setPikvmHost("");
      setPikvmPassword("");
      setCameraUrl("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this equipment.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(eq: EquipmentDto) {
    setEditingId(eq.id);
    setEdit(editStateFor(eq));
    setEditError(null);
  }

  async function submitEdit(equipmentId: string, ev: React.FormEvent) {
    ev.preventDefault();
    if (!edit) return;
    setEditError(null);
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = {
        name: edit.name,
        pikvmHost: edit.pikvmHost,
        pikvmUser: edit.pikvmUser,
        targetOs: edit.targetOs,
        keymap: edit.keymap,
        screenWidth: edit.screenWidth,
        screenHeight: edit.screenHeight,
        cameraUrl: edit.cameraUrl || null,
      };
      // Blank means "leave the stored password unchanged" -- see UpdateEquipmentRequestSchema.
      if (edit.pikvmPassword) body.pikvmPassword = edit.pikvmPassword;
      await api.patch(`/equipment/${equipmentId}`, body);
      setEditingId(null);
      setEdit(null);
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not update this equipment.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function toggleMaintenance(eq: EquipmentDto) {
    setMaintenanceError(null);
    setMaintenanceActionId(eq.id);
    try {
      const path = eq.status === "MAINTENANCE" ? `/equipment/${eq.id}/maintenance/clear` : `/equipment/${eq.id}/maintenance`;
      await api.post(path);
      await load();
    } catch (err) {
      setMaintenanceError(err instanceof ApiError ? err.message : "Could not update this equipment's maintenance state.");
    } finally {
      setMaintenanceActionId(null);
    }
  }

  return (
    <div>
      <header className="topbar">
        <strong>Manage equipment</strong>
        <button className="btn secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </header>

      <main className="page">
        <h1>Equipment</h1>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1em" }}>Add equipment</h2>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="eq-name">Name</label>
              <input id="eq-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="MRI-02" required />
            </div>
            <div className="field">
              <label htmlFor="eq-host">PiKVM host</label>
              <input
                id="eq-host"
                value={pikvmHost}
                onChange={(e) => setPikvmHost(e.target.value)}
                placeholder="https://192.168.1.51"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="eq-user">PiKVM username</label>
              <input id="eq-user" value={pikvmUser} onChange={(e) => setPikvmUser(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="eq-password">PiKVM password</label>
              <input
                id="eq-password"
                type="password"
                value={pikvmPassword}
                onChange={(e) => setPikvmPassword(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="eq-os">Target OS</label>
              <select id="eq-os" value={targetOs} onChange={(e) => setTargetOs(e.target.value as TargetOs)}>
                {TARGET_OS_OPTIONS.map((os) => (
                  <option key={os} value={os}>
                    {os}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="eq-keymap">Keymap</label>
              <select id="eq-keymap" value={keymap} onChange={(e) => setKeymap(e.target.value)}>
                {PIKVM_KEYMAPS.map((km) => (
                  <option key={km} value={km}>
                    {km}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="eq-width">Screen width</label>
              <input
                id="eq-width"
                type="number"
                min={1}
                value={screenWidth}
                onChange={(e) => setScreenWidth(Number(e.target.value))}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="eq-height">Screen height</label>
              <input
                id="eq-height"
                type="number"
                min={1}
                value={screenHeight}
                onChange={(e) => setScreenHeight(Number(e.target.value))}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="eq-camera">Room camera URL (optional)</label>
              <input
                id="eq-camera"
                value={cameraUrl}
                onChange={(e) => setCameraUrl(e.target.value)}
                placeholder="http://mediamtx-host:8889/cctv/whep"
              />
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="btn" type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create equipment"}
            </button>
          </form>
          {created && (
            <p role="status" style={{ marginTop: 14, color: "#5fdc8a" }}>
              ✓ {created.name} created. It'll show up on the dashboard once its PiKVM connection comes online.
            </p>
          )}
        </div>

        <div className="card">
          {maintenanceError && (
            <p className="error" role="alert">
              {maintenanceError}
            </p>
          )}
          {loadError ? (
            <p className="error" role="alert">
              {loadError}{" "}
              <button className="link-button" onClick={() => void load()}>
                Retry
              </button>
            </p>
          ) : loading ? (
            <p aria-live="polite">Loading...</p>
          ) : equipment.length === 0 ? (
            <p style={{ color: "#9aa4b2" }}>No equipment registered for your tenant yet.</p>
          ) : (
            equipment.map((eq) => (
              <div key={eq.id} style={{ borderBottom: "1px solid #262b36", paddingBottom: 14, marginBottom: 14 }}>
                <div className="equipment-row" style={{ borderBottom: "none", paddingBottom: 0 }}>
                  <div>
                    <h3 style={{ display: "inline", fontSize: "1em", margin: 0 }}>{eq.name}</h3>{" "}
                    <span className={`badge ${eq.status.toLowerCase()}`}>{eq.status}</span>
                    <div style={{ color: "#9aa4b2", fontSize: 13 }}>
                      {eq.pikvmHost} · {eq.targetOs} · keymap {eq.keymap} · {eq.screenWidth}x{eq.screenHeight}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn secondary"
                      onClick={() => (editingId === eq.id ? setEditingId(null) : startEdit(eq))}
                    >
                      {editingId === eq.id ? "Cancel" : "Edit"}
                    </button>
                    <button className="btn secondary" disabled={maintenanceActionId === eq.id} onClick={() => toggleMaintenance(eq)}>
                      {eq.status === "MAINTENANCE" ? "Clear maintenance" : "Enter maintenance"}
                    </button>
                  </div>
                </div>

                {editingId === eq.id && edit && (
                  <form onSubmit={(ev) => submitEdit(eq.id, ev)} style={{ marginTop: 12 }}>
                    <div className="field">
                      <label htmlFor={`edit-name-${eq.id}`}>Name</label>
                      <input id={`edit-name-${eq.id}`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-host-${eq.id}`}>PiKVM host</label>
                      <input
                        id={`edit-host-${eq.id}`}
                        value={edit.pikvmHost}
                        onChange={(e) => setEdit({ ...edit, pikvmHost: e.target.value })}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-user-${eq.id}`}>PiKVM username</label>
                      <input
                        id={`edit-user-${eq.id}`}
                        value={edit.pikvmUser}
                        onChange={(e) => setEdit({ ...edit, pikvmUser: e.target.value })}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-password-${eq.id}`}>PiKVM password (leave blank to keep unchanged)</label>
                      <input
                        id={`edit-password-${eq.id}`}
                        type="password"
                        value={edit.pikvmPassword}
                        onChange={(e) => setEdit({ ...edit, pikvmPassword: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-os-${eq.id}`}>Target OS</label>
                      <select
                        id={`edit-os-${eq.id}`}
                        value={edit.targetOs}
                        onChange={(e) => setEdit({ ...edit, targetOs: e.target.value as TargetOs })}
                      >
                        {TARGET_OS_OPTIONS.map((os) => (
                          <option key={os} value={os}>
                            {os}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-keymap-${eq.id}`}>Keymap</label>
                      <select id={`edit-keymap-${eq.id}`} value={edit.keymap} onChange={(e) => setEdit({ ...edit, keymap: e.target.value })}>
                        {PIKVM_KEYMAPS.map((km) => (
                          <option key={km} value={km}>
                            {km}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-width-${eq.id}`}>Screen width</label>
                      <input
                        id={`edit-width-${eq.id}`}
                        type="number"
                        min={1}
                        value={edit.screenWidth}
                        onChange={(e) => setEdit({ ...edit, screenWidth: Number(e.target.value) })}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-height-${eq.id}`}>Screen height</label>
                      <input
                        id={`edit-height-${eq.id}`}
                        type="number"
                        min={1}
                        value={edit.screenHeight}
                        onChange={(e) => setEdit({ ...edit, screenHeight: Number(e.target.value) })}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`edit-camera-${eq.id}`}>Room camera URL (optional)</label>
                      <input
                        id={`edit-camera-${eq.id}`}
                        value={edit.cameraUrl}
                        onChange={(e) => setEdit({ ...edit, cameraUrl: e.target.value })}
                      />
                    </div>
                    {editError && (
                      <p className="error" role="alert">
                        {editError}
                      </p>
                    )}
                    <button className="btn" type="submit" disabled={savingEdit}>
                      {savingEdit ? "Saving..." : "Save changes"}
                    </button>
                  </form>
                )}
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
