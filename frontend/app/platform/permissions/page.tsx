'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, ErrorState, Loading, PageHeader } from '@/components/ui';

type Row = { module: string; operations: number; minRoleToView: string | null; minRoleToChange: string | null; byRole: Record<string, { view: boolean; change: boolean }> };
type Data = { workspaceRoles: string[]; workspace: Row[]; organization: Array<{ action: string; roles: string[] }>; platform: Array<{ role: string; permissions: string[] }> };
const label = (r: string) => r.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const ORG_ROLES = ['OWNER', 'ADMIN', 'BILLING', 'MEMBER'];

function Cell({ view, change }: { view: boolean; change: boolean }) {
  if (change) return <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">View & change</span>;
  if (view) return <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-semibold text-blue-700">View</span>;
  return <span className="text-xs text-slate-300">No access</span>;
}

/** Read from the API's own route table, so it always matches what the server enforces. */
export default function Permissions() {
  const q = useQuery({ queryKey: ['platform-permissions'], queryFn: () => api<Data>('/platform/permissions') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <>
      <PageHeader title="Permission matrix" subtitle="Who can do what inside a customer workspace and organization. Generated from the API’s route rules, so it matches what the server enforces. Change a person’s role from Tenants → a tenant → Members." />
      <Card title="Workspace roles, by module">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="permission-matrix">
            <thead><tr><th className="th">Module</th>{d.workspaceRoles.map((r) => <th key={r} className="th text-center">{label(r)}</th>)}</tr></thead>
            <tbody>{d.workspace.map((row) => (
              <tr key={row.module} className="border-t border-slate-100">
                <td className="td"><b>{row.module}</b><p className="text-xs text-slate-500">{row.operations} API operation{row.operations === 1 ? '' : 's'}</p></td>
                {d.workspaceRoles.map((r) => <td key={r} className="td text-center"><Cell {...row.byRole[r]} /></td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Organization roles">
          <table className="w-full text-sm">
            <thead><tr><th className="th">Action</th>{ORG_ROLES.map((r) => <th key={r} className="th text-center">{label(r)}</th>)}</tr></thead>
            <tbody>{d.organization.map((a) => <tr key={a.action} className="border-t border-slate-100"><td className="td">{a.action}</td>{ORG_ROLES.map((r) => <td key={r} className="td text-center">{a.roles.includes(r) ? <span className="font-bold text-emerald-700" aria-label="allowed">✓</span> : <span className="text-slate-300" aria-label="not allowed">—</span>}</td>)}</tr>)}</tbody>
          </table>
        </Card>
        <Card title="Staff roles (this console)">
          <ul className="space-y-3 text-sm">{d.platform.map((p) => <li key={p.role}><b>{label(p.role)}</b><p className="text-xs text-slate-500">{p.permissions.join(', ')}</p></li>)}</ul>
        </Card>
      </div>
    </>
  );
}
