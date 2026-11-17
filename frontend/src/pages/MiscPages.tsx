import { Link } from "react-router";
import { PageHead } from "../components/Card";
import { NoPermission } from "../components/States";
import { useSession } from "../hooks/useSession";
import { api } from "../services/api";

export async function signOut() {
  await api.logout().catch(() => null);
  window.location.assign("/");
}

/** Signed in, but no Zoiko Pay role is assigned: deny by default. */
export function NoAccessPage() {
  const { me } = useSession();
  return (
    <main style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ width: "min(520px, 100%)" }}>
        <NoPermission>
          You are signed in as <span className="mono">{me?.username}</span>, but no Zoiko Pay role is assigned to this account. Ask an administrator to grant you access.
        </NoPermission>
        <div className="card-foot" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={signOut}>Sign out</button>
        </div>
      </div>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHead title="Page not found" description="This address does not match any console screen." />
      <Link to="/" className="btn">Back to dashboard</Link>
    </>
  );
}

export function ForbiddenRoute() {
  return (
    <>
      <PageHead title="Not available" />
      <div className="card"><NoPermission /></div>
    </>
  );
}
