import { Card, PageHeader } from '../components/ui';

/** A section delivered by a later lot (10 — Delivery Plan). */
export function ComingLaterPage({ title, purpose }: { title: string; purpose: string }) {
  return (
    <>
      <PageHeader title={title} help="index" />
      <Card>
        <p className="font-medium">Coming in a later version.</p>
        <p className="mt-2 text-slate-700">{purpose}</p>
      </Card>
    </>
  );
}
