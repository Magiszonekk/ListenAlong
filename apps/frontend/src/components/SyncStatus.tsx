interface SyncStatusProps {
  status: string;
}

export function SyncStatus({ status }: SyncStatusProps) {
  return (
    <p className="text-sm text-muted-foreground text-center">{status}</p>
  );
}
