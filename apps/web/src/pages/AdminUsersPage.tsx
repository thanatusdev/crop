import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { UserDto, UserRole } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";

const CREATABLE_ROLES: UserRole[] = ["CLINIC_ADMIN", "SUPERVISOR", "OPERATOR", "AUDITOR"] as UserRole[];

export default function AdminUsersPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reset-password: which row (if any) has its inline "new password" form open.
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Create user.
  const [newEmail, setNewEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>(CREATABLE_ROLES[2]!); // OPERATOR
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Shown once, right after creation -- there's no mailer, so this is the only place the
  // admin ever sees these values. Cleared as soon as they navigate away or create another.
  const [justCreated, setJustCreated] = useState<{ email: string; password: string; role: UserRole } | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setUsers(await api.get<UserDto[]>("/users"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }

  async function toggleLock(user: UserDto) {
    setActionError(null);
    setActingOnId(user.id);
    try {
      await api.post(`/users/${user.id}/${user.locked ? "unlock" : "lock"}`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update this user.");
    } finally {
      setActingOnId(null);
    }
  }

  async function submitResetPassword(userId: string, ev: React.FormEvent) {
    ev.preventDefault();
    setActionError(null);
    setActingOnId(userId);
    try {
      await api.post(`/users/${userId}/reset-password`, { newPassword });
      setResettingId(null);
      setNewPassword("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not reset this user's password.");
    } finally {
      setActingOnId(null);
    }
  }

  async function submitCreate(ev: React.FormEvent) {
    ev.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await api.post("/users", { email: newEmail, password: newUserPassword, role: newRole });
      setJustCreated({ email: newEmail, password: newUserPassword, role: newRole });
      setNewEmail("");
      setNewUserPassword("");
      setNewRole(CREATABLE_ROLES[2]!);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this user.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <header className="topbar">
        <strong>Manage users</strong>
        <button className="btn secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </header>

      <main className="page">
        <h1>Users</h1>

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1em" }}>Create user</h2>
          <p style={{ color: "#9aa4b2", fontSize: 13, marginTop: -6 }}>
            There's no mailer -- relay this email and password to them yourself (Slack, in person, whatever your clinic
            already uses). They'll set up two-factor authentication themselves on their first login.
          </p>
          <form onSubmit={submitCreate}>
            <div className="field">
              <label htmlFor="new-user-email">Email</label>
              <input id="new-user-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="new-user-password">Temporary password</label>
              <input
                id="new-user-password"
                type="password"
                minLength={8}
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="new-user-role">Role</label>
              <select id="new-user-role" value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
                {CREATABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
            {createError && (
              <p className="error" role="alert">
                {createError}
              </p>
            )}
            <button className="btn" type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create user"}
            </button>
          </form>
          {justCreated && (
            <div className="card" style={{ marginTop: 14, marginBottom: 0, borderColor: "#5fdc8a" }} role="status">
              <strong style={{ color: "#5fdc8a" }}>User created.</strong> Give them these to sign in with:
              <div style={{ fontFamily: "monospace", fontSize: 13, marginTop: 8 }}>
                email: {justCreated.email}
                <br />
                password: {justCreated.password}
                <br />
                role: {justCreated.role}
              </div>
            </div>
          )}
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
          ) : users.length === 0 ? (
            <p style={{ color: "#9aa4b2" }}>No users in your tenant yet.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Users in your tenant</caption>
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">2FA</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td>{u.role}</td>
                      <td>{u.mfaEnrolled ? "Enrolled" : "Not enrolled yet"}</td>
                      <td>
                        <span className={`badge ${u.locked ? "offline" : "online"}`}>{u.locked ? "LOCKED" : "ACTIVE"}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button className="btn secondary" disabled={actingOnId === u.id} onClick={() => toggleLock(u)}>
                            {u.locked ? "Unlock" : "Lock"}
                          </button>
                          <button
                            className="btn secondary"
                            onClick={() => {
                              setResettingId(resettingId === u.id ? null : u.id);
                              setNewPassword("");
                            }}
                          >
                            Reset password
                          </button>
                        </div>
                        {resettingId === u.id && (
                          <form onSubmit={(ev) => submitResetPassword(u.id, ev)} style={{ marginTop: 8, display: "flex", gap: 8 }}>
                            <label className="visually-hidden" htmlFor={`reset-pw-${u.id}`}>
                              New password for {u.email}
                            </label>
                            <input
                              id={`reset-pw-${u.id}`}
                              type="password"
                              placeholder="New password"
                              minLength={8}
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              required
                            />
                            <button className="btn" type="submit" disabled={actingOnId === u.id}>
                              Confirm
                            </button>
                          </form>
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
