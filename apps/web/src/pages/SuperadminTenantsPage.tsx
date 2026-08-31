import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TenantDto } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";

export default function SuperadminTenantsPage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setTenants(await api.get<TenantDto[]>("/tenants"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load tenants.");
    } finally {
      setLoading(false);
    }
  }

  async function submitCreate(ev: React.FormEvent) {
    ev.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await api.post("/tenants", { name: newName });
      setNewName("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this tenant.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleDeactivate(tenant: TenantDto) {
    setActionError(null);
    setActingOnId(tenant.id);
    try {
      await api.post(`/tenants/${tenant.id}/${tenant.deactivated ? "reactivate" : "deactivate"}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not update this tenant.");
    } finally {
      setActingOnId(null);
    }
  }

  return (
    <div>
      <header className="topbar">
        <strong>Manage tenants</strong>
        <button className="btn secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </header>

      <main className="page">
        <h1>Tenants</h1>

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1em" }}>Create tenant</h2>
          <p style={{ color: "#9aa4b2", fontSize: 13, marginTop: -6 }}>
            Creates an empty clinic with no users or equipment yet. Head to{" "}
            <button className="link-button" onClick={() => navigate("/admin/users")}>
              Manage users
            </button>{" "}
            to bootstrap its first CLINIC_ADMIN -- the tenant picker there is only visible to PLATFORM_ADMIN.
          </p>
          <form onSubmit={submitCreate}>
            <div className="field">
              <label htmlFor="new-tenant-name">Name</label>
              <input id="new-tenant-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Clinica Gamma" required />
            </div>
            {createError && (
              <p className="error" role="alert">
                {createError}
              </p>
            )}
            <button className="btn" type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create tenant"}
            </button>
          </form>
        </div>

        <div className="card">
          {actionError && (
            <p className="error" role="alert">
              {actionError}
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
          ) : tenants.length === 0 ? (
            <p style={{ color: "#9aa4b2" }}>No tenants yet.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Every tenant on the platform</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Created</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{t.type}</td>
                      <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                      <td>
                        <span className={`badge ${t.deactivated ? "offline" : "online"}`}>{t.deactivated ? "DEACTIVATED" : "ACTIVE"}</span>
                      </td>
                      <td>
                        {t.type === "PLATFORM" ? (
                          <span style={{ color: "#9aa4b2", fontSize: 13 }}>-</span>
                        ) : (
                          <button className="btn secondary" disabled={actingOnId === t.id} onClick={() => toggleDeactivate(t)}>
                            {t.deactivated ? "Reactivate" : "Deactivate"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
