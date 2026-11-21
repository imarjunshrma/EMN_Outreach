'use client';

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty } from './ui';

export function DailyChart({ rows }: { rows: Array<{ day: string; sent: number; replied: number; bounced: number; leads?: number }> }) {
  if (!rows.some((r) => r.sent || r.replied || r.bounced || r.leads)) return <Empty title="No activity in this period yet">Charts fill in as emails are sent and replies arrive.</Empty>;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ left: -10, right: 10 }}>
          <CartesianGrid vertical={false} stroke="rgb(165 156 173 / 0.28)" />
          <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} fontSize={11} tickLine={false} axisLine={false} stroke="#786f80" />
          <YAxis allowDecimals={false} fontSize={11} tickLine={false} axisLine={false} stroke="#786f80" />
          <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e0e9', fontSize: 12 }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="sent" stroke="#c62f96" strokeWidth={2.5} dot={false} name="Sent" />
          <Line type="monotone" dataKey="replied" stroke="#0f9d6b" strokeWidth={2} dot={false} name="Replies" />
          <Line type="monotone" dataKey="bounced" stroke="#dc2626" strokeWidth={2} dot={false} name="Bounces" />
          {rows[0]?.leads !== undefined && <Line type="monotone" dataKey="leads" stroke="#a59cad" strokeWidth={1} dot={false} name="New prospects" />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SimpleBars({ rows, keys }: { rows: Array<Record<string, string | number>>; keys: Array<{ key: string; label: string; color: string }>; }) {
  if (rows.length === 0) return <Empty title="No data yet" />;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ left: -10, right: 10 }}>
          <CartesianGrid vertical={false} stroke="rgb(165 156 173 / 0.28)" />
          <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} stroke="#786f80" />
          <YAxis allowDecimals={false} fontSize={11} tickLine={false} axisLine={false} stroke="#786f80" />
          <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e0e9', fontSize: 12 }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          {keys.map((k) => <Bar key={k.key} dataKey={k.key} fill={k.color} name={k.label} radius={[4, 4, 0, 0]} maxBarSize={28} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
