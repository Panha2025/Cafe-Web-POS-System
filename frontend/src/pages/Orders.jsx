import { useEffect, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, ArrowUpRight, ReceiptText } from 'lucide-react';
import { api, money, dateTime } from '../services/api';
import { useApp } from '../context/AppContext';
import { PageHeading, Empty, Spinner } from '../components/UI';
import Receipt from '../components/Receipt';
export default function Orders() {
  const { notify, outboxStatus } = useApp();
  const [filter, setFilter] = useState({ date: '', number: '', method: '' }),
    [page, setPage] = useState(1),
    [data, setData] = useState(null),
    [receipt, setReceipt] = useState(null),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api(`/orders?${new URLSearchParams({ ...filter, page })}`)
        .then((d) => {
          if (active) {
            setData(d);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filter, page, reload]);
  const update = (key, value) => {
    setFilter({ ...filter, [key]: value });
    setPage(1);
  };
  async function open(id) {
    try {
      setReceipt(await api(`/orders/${id}`));
    } catch (e) {
      notify(e.message, 'error');
    }
  }
  return (
    <div className="page">
      <PageHeading
        eyebrow="EVERY CUP HAS A STORY"
        title="Order History"
        description="All your completed orders, in one place."
      />
      {outboxStatus.orders.some((record) => record.state !== 'synced') && (
        <section className="surface offline-history-panel">
          <div className="section-heading">
            <div>
              <h3>Offline sale records on this device</h3>
              <p>Pending, review, and rejected sales are not finalized revenue.</p>
            </div>
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
                      record.provisional_receipt?.currency || 'USD',
                    )}
                  </b>
                </button>
              ))}
          </div>
        </section>
      )}
      <div className="surface">
        <div className="table-toolbar order-filters">
          <div className="search-field">
            <Search size={18} />
            <input
              aria-label="Search order number"
              placeholder="Search order number…"
              value={filter.number}
              onChange={(e) => update('number', e.target.value)}
            />
          </div>
          <input
            aria-label="Filter date"
            type="date"
            value={filter.date}
            onChange={(e) => update('date', e.target.value)}
          />
          <select
            aria-label="Filter payment method"
            value={filter.method}
            onChange={(e) => update('method', e.target.value)}
          >
            <option value="">All payment methods</option>
            <option value="cash">Cash</option>
            <option value="khqr">KHQR</option>
            <option value="card">Card</option>
          </select>
          <button
            className="button secondary"
            onClick={() => {
              setFilter({ date: '', number: '', method: '' });
              setPage(1);
              setReload((v) => v + 1);
            }}
          >
            Reset
          </button>
        </div>
        {error ? (
          <div className="form-error" role="alert">
            {error}
            <button onClick={() => setReload((v) => v + 1)}>Try again</button>
          </div>
        ) : !data ? (
          <Spinner />
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Order number</th>
                    <th>Date & time</th>
                    <th>Cashier</th>
                    <th>Origin</th>
                    <th>Items</th>
                    <th>Total</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <button className="text-button" onClick={() => open(o.id)}>
                          {o.order_number}
                        </button>
                      </td>
                      <td>{dateTime(o.created_at)}</td>
                      <td>{o.cashier}</td>
                      <td>{o.source === 'offline' ? 'Offline cash' : 'Online'}</td>
                      <td>{o.item_count}</td>
                      <td className="price">{money(o.total, o.currency)}</td>
                      <td className="uppercase">{o.payment_method}</td>
                      <td>
                        <span className="status">Paid</span>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`View ${o.order_number}`}
                          onClick={() => open(o.id)}
                        >
                          <ArrowUpRight size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.orders.length && (
              <Empty
                icon={ReceiptText}
                title="No orders found"
                description="Completed orders will appear here. Try clearing your filters."
              />
            )}
            <div className="pagination">
              <span>
                {data.total} orders · Page {page} of {data.pages || 1}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label="Previous page"
                  disabled={page === 1}
                  onClick={() => setPage((v) => v - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Next page"
                  disabled={page >= data.pages}
                  onClick={() => setPage((v) => v + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {receipt && <Receipt order={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
