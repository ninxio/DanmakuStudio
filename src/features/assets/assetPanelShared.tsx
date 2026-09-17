export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2">
      <dt className="min-w-0 truncate text-content-muted">{label}</dt>
      <dd className="truncate text-content-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded border border-dashed border-panel-line bg-surface-inset p-4 text-center">
      <h3 className="text-sm font-medium text-content-secondary">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-content-muted">{text}</p>
    </div>
  );
}
