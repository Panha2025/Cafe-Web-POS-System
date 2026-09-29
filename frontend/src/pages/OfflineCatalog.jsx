import { useEffect, useState } from 'react';
import { Coffee } from 'lucide-react';
import { money } from '../services/api';
import { useApp } from '../context/AppContext';
import SyncStatus from '../components/SyncStatus';
import POS from './POS';
import Receipt from '../components/Receipt';

export default function OfflineCatalog() {
  const { offlineCatalog, posStatus, outboxStatus } = useApp();
  const [receipt, setReceipt] = useState(null);
  useEffect(() => {
    if (!receipt?.request_id) return;
    const updated = outboxStatus.orders.find((record) => record.request_id === receipt.request_id);
    if (updated?.provisional_receipt) setReceipt(updated.provisional_receipt);
  }, [outboxStatus.orders, receipt?.request_id]);
  if (!offlineCatalog) return null;
  const settings = offlineCatalog.settings;
  const offlineSalesReady =
    posStatus.offlineSales &&
    posStatus.storage === 'available' &&
    posStatus.catalog === 'verified' &&
    !posStatus.clockRollback;
  return (
    <main className="offline-catalog-page">
      <header className="offline-catalog-header">
        <div className="brand-icon">
          <Coffee size={28} />
        </div>
        <div>
          <strong>{settings.cafe_name}</strong>
          <p>{offlineSalesReady ? 'Offline cash sales' : 'Read-only offline catalog'}</p>
        </div>
      </header>
      <SyncStatus />
      {outboxStatus.orders.some((record) => record.state !== 'synced') && (
        <section className="offline-outbox">
          <div>
            <h2>Offline sale records</h2>
            <p>Saved on this device. Pending and review records are not finalized revenue.</p>
          </div>
          <div className="offline-outbox-list">
            {outboxStatus.orders
              .filter((record) => record.state !== 'synced')
              .slice()
              .reverse()
              .slice(0, 20)
              .map((record) => (
                <button
                  type="button"
                  className="offline-outbox-row"
                  key={record.request_id}
                  onClick={() => setReceipt(record.provisional_receipt)}
                >
                  <span>
                    <strong>{record.provisional_receipt?.order_number || record.request_id}</strong>
                    <small>{record.state.replaceAll('_', ' ')}</small>
                  </span>
                  <b>
                    {money(
                      record.provisional_receipt?.total,
                      record.provisional_receipt?.currency || settings.currency,
                    )}
                  </b>
                </button>
              ))}
          </div>
        </section>
      )}
      {offlineSalesReady ? (
        <POS search="" offlineOnly />
      ) : (
        <section className="offline-catalog-content">
          <p className="eyebrow">CACHED CATALOG · VERSION {offlineCatalog.catalog_version}</p>
          <h1>{settings.cafe_name}</h1>
          <p className="muted">
            This verified menu is available for reference. A valid offline cash lease is required to
            save offline sales.
          </p>
          {offlineCatalog.categories.map((category) => {
            const items = offlineCatalog.products.filter(
              (product) =>
                product.category_id === category.id && product.available && !product.deleted_at,
            );
            if (!items.length) return null;
            return (
              <section className="offline-catalog-category" key={category.id}>
                <h2>{category.name}</h2>
                <div className="offline-catalog-grid">
                  {items.map((product) => (
                    <article className="offline-catalog-product" key={product.id}>
                      <img src={product.image_url || '/images/coffee.svg'} alt="" />
                      <div>
                        <strong>{product.name}</strong>
                        <span>{money(product.price, settings.currency)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </section>
      )}
      {receipt && <Receipt order={receipt} onClose={() => setReceipt(null)} />}
    </main>
  );
}
