export interface TrackingCounts {
  rawPixels: number;
  uniquePixels: number;
  automatedPixels: number;
  estimatedOpens: number;
  rawClicks: number;
  uniqueLinks: number;
  automatedClicks: number;
  estimatedClicks: number;
}

export function TrackingTotals({ totals }: { totals?: TrackingCounts }) {
  if (!totals) return null;
  return (
    <div className="space-y-1 text-xs">
      <p>Pixels · {totals.rawPixels} requests · {totals.uniquePixels} messages · {totals.automatedPixels} suspected automated · {totals.estimatedOpens} estimated opens</p>
      <p>Links · {totals.rawClicks} requests · {totals.uniqueLinks} tracked links · {totals.automatedClicks} suspected automated · {totals.estimatedClicks} estimated clicks</p>
    </div>
  );
}
