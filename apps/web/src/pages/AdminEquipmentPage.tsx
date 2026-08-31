import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PIKVM_KEYMAPS, DEFAULT_KEYMAP, type EquipmentDto, type TargetOs } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";

const TARGET_OS_OPTIONS: TargetOs[] = ["WINDOWS", "MACOS", "LINUX"] as TargetOs[];

export default function AdminEquipmentPage() {
  const navigate = useNavigate();
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

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const equipment = await api.post<EquipmentDto>("/equipment", {
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
      setCreated(equipment);
      setName("");
      setPikvmHost("");
      setPikvmPassword("");
      setCameraUrl("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this equipment.");
    } finally {
      setCreating(false);
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
        <h1>Add equipment</h1>
        <div className="card">
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
      </main>
    </div>
  );
}
