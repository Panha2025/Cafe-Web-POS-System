import { useApp } from '../context/AppContext';

const title = (status) => status.replaceAll('_', ' ');

export default function SyncStatus() {
  const { posStatus, outboxStatus, syncOutbox, applyUpdate, notify } = useApp();
  const server = !posStatus.network
    ? 'network unavailable'
    : posStatus.server === 'reachable'
      ? 'server reachable'
      : posStatus.server === 'checking'
        ? 'checking server'
        : 'server unreachable';
  const items = [
    ['Connection', server],
    ['Catalog', title(posStatus.catalog)],
    ['Device', title(posStatus.device)],
    ['Lease', title(posStatus.lease)],
    [
      'Storage',
      posStatus.storage === 'available' ? 'persistent storage available' : title(posStatus.storage),
    ],
  ];
  return (
    <div className="pos-sync-status" role="status" aria-live="polite" data-testid="pos-sync-status">
      <div className="pos-sync-items">
        {items.map(([label, value]) => (
          <span className={`status-item status-${value.replaceAll(' ', '-')}`} key={label}>
            <i aria-hidden="true" />
            <b>{label}</b> {value}
          </span>
        ))}
        {posStatus.clockRollback && (
          <span className="status-warning">Device clock moved backwards; verify online.</span>
        )}
        {posStatus.deviceError && <span className="status-warning">{posStatus.deviceError}</span>}
        <span className="status-readonly">
          {posStatus.offlineSales
            ? 'Offline cash sales available'
            : 'Offline cash authorization unavailable'}
        </span>
        {(outboxStatus.pending > 0 ||
          outboxStatus.needsReview > 0 ||
          outboxStatus.rejected > 0) && (
          <span className="status-item status-outbox">
            <b>Offline orders</b>{' '}
            {outboxStatus.syncing ? 'syncing' : `${outboxStatus.pending} pending`}
            {outboxStatus.needsReview > 0 && ` · ${outboxStatus.needsReview} need review`}
            {outboxStatus.rejected > 0 && ` · ${outboxStatus.rejected} rejected`}
          </span>
        )}
        {outboxStatus.lastSuccessfulSync && (
          <span className="status-item">
            Last sync{' '}
            {new Date(outboxStatus.lastSuccessfulSync).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
        {outboxStatus.syncErrors.length > 0 && (
          <span className="status-warning">Some offline sales could not be confirmed yet.</span>
        )}
      </div>
      {outboxStatus.pending > 0 && posStatus.server === 'reachable' && (
        <button
          className="button secondary status-update"
          disabled={outboxStatus.syncing}
          onClick={async () => {
            try {
              await syncOutbox(true);
            } catch {
              notify(
                'Offline sales could not be synchronized yet. They remain saved on this device.',
                'error',
              );
            }
          }}
        >
          {outboxStatus.syncing ? 'Syncing offline sales…' : 'Sync offline sales'}
        </button>
      )}
      {posStatus.updateWaiting && (
        <button
          className="button secondary status-update"
          onClick={async () => {
            try {
              await applyUpdate();
            } catch (error) {
              notify(error.message, 'error');
            }
          }}
        >
          App update waiting · Apply
        </button>
      )}
    </div>
  );
}
