import { useEffect, useState } from 'react';
import { Banknote, ShoppingBag, TrendingUp, Coffee, ArrowUpRight } from 'lucide-react';
import { api, money, dateTime } from '../services/api';
import { useApp } from '../context/AppContext';
import { PageHeading, Spinner, Empty } from '../components/UI';
import Receipt from '../components/Receipt';
export default function Reports() {
  const { settings, notify } = useApp();
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [currency, setCurrency] = useState(settings.currency),
    [receipt, setReceipt] = useState(null),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api('/reports/summary')
        .then((d) => {
          if (live) {
            setData(d);
            setError('');
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    const t = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [reload]);
  const fmt = (n) => money(n, currency);
  const metric = data?.metrics.find((m) => m.currency === currency) || {};
  const cards = [
    ['Today’s Revenue', fmt(metric.today_revenue), Banknote, 'Completed sales today'],
    ['Today’s Orders', metric.today_orders || 0, ShoppingBag, 'Every order, freshly counted'],
    ['This Month Revenue', fmt(metric.month_revenue), TrendingUp, 'Your month so far'],
    ['Average Order Value', fmt(metric.average_order_value), Coffee, 'Across all completed orders'],
  ];
  const currencies = [
    ...new Set([settings.currency, ...(data?.metrics || []).map((m) => m.currency)]),
  ];
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
        eyebrow="A FRESH PERSPECTIVE"
        title="Sales Report"
        description="A clear view of how your café is doing."
      >
        <div className="report-controls">
          <span className="live-badge">
            <i /> Live sales data
          </span>
          <select
            aria-label="Report currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </PageHeading>
      {error ? (
        <div className="form-error">
          {error}
          <button onClick={() => setReload((v) => v + 1)}>Try again</button>
        </div>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          <div className="stat-grid">
            {cards.map(([title, value, Icon, note]) => (
              <div className="stat-card" key={title}>
                <div>
                  <span>{title}</span>
                  <Icon size={20} />
                </div>
                <strong>{value}</strong>
                <small>{note}</small>
              </div>
            ))}
          </div>
          <div className="report-grid">
            <section className="surface chart-panel">
              <div className="section-heading">
                <div>
                  <h3>The week in cups</h3>
                  <p>Revenue over the last 7 days</p>
                </div>
                <span className="pill subtle">{currency}</span>
              </div>
              <SalesChart
                daily={data.daily.filter((d) => d.currency === currency)}
                timezone={data.timezone}
                fmt={fmt}
              />
            </section>
            <section className="surface payment-report">
              <h3>Sales by payment method</h3>
              <p className="muted">All completed payments · {currency}</p>
              {['cash', 'khqr', 'card'].map((method) => {
                const p = data.payments.find((p) => p.method === method && p.currency === currency);
                const sum = data.payments
                  .filter((p) => p.currency === currency)
                  .reduce((sum, p) => sum + Number(p.revenue), 0);
                return (
                  <div className="payment-stat" key={method}>
                    <div>
                      <strong className="uppercase">{method}</strong>
                      <b>{fmt(p?.revenue)}</b>
                    </div>
                    <div className="progress-track">
                      <div
                        style={{ width: `${sum ? (Number(p?.revenue || 0) / sum) * 100 : 0}%` }}
                      />
                    </div>
                    <small>
                      {p?.orders || 0} orders ·{' '}
                      {sum ? Math.round((Number(p?.revenue || 0) / sum) * 100) : 0}% of revenue
                    </small>
                  </div>
                );
              })}
            </section>
            <section className="surface best-panel">
              <div className="section-heading">
                <div>
                  <h3>Best-selling products</h3>
                  <p>Your customers’ all-time favorites</p>
                </div>
                <Coffee size={21} />
              </div>
              {data.best.filter((p) => p.currency === currency).length ? (
                data.best
                  .filter((p) => p.currency === currency)
                  .map((p, i) => (
                    <div className="best-row" key={`${p.product_id}-${p.product_name}`}>
                      <span className="rank">{String(i + 1).padStart(2, '0')}</span>
                      <div>
                        <strong>{p.product_name}</strong>
                        <small>{p.quantity} items sold</small>
                      </div>
                      <b>{fmt(p.revenue)}</b>
                    </div>
                  ))
              ) : (
                <Empty
                  title="Favorites in the making"
                  description="Your best sellers will appear after the first sale."
                />
              )}
            </section>
            <section className="surface recent-panel">
              <div className="section-heading">
                <div>
                  <h3>Fresh off the counter</h3>
                  <p>Most recent orders · all currencies</p>
                </div>
                <ShoppingBag size={21} />
              </div>
              {data.recent.length ? (
                data.recent.map((o) => (
                  <button className="recent-row" key={o.id} onClick={() => open(o.id)}>
                    <div>
                      <strong>{o.order_number}</strong>
                      <small>
                        {dateTime(o.created_at)} · {o.cashier} ·{' '}
                        {o.source === 'offline' ? 'Offline cash' : 'Online'}
                      </small>
                    </div>
                    <b>{money(o.total, o.currency)}</b>
                    <ArrowUpRight size={17} />
                  </button>
                ))
              ) : (
                <Empty
                  title="Your first sale is waiting"
                  description="Completed orders will show up here."
                />
              )}
            </section>
            <section className="surface offline-review-panel">
              <div className="section-heading">
                <div>
                  <h3>Offline sales outside finalized totals</h3>
                  <p>These receipts are not included in revenue until accepted.</p>
                </div>
              </div>
              {data.offlineReview?.length ? (
                <div className="offline-review-list">
                  {data.offlineReview.map((item) => (
                    <div className="offline-review-row" key={item.request_id}>
                      <div>
                        <strong>
                          {item.outcome === 'needs_review' ? 'Needs review' : 'Rejected'}
                        </strong>
                        <small>
                          {item.device_name || 'POS device'} · sequence{' '}
                          {item.device_sequence || '—'} · {dateTime(item.created_at)}
                        </small>
                      </div>
                      <b>
                        {item.recorded_total &&
                        ['USD', 'KHR', 'EUR', 'GBP', 'THB'].includes(item.currency)
                          ? money(item.recorded_total, item.currency)
                          : '—'}
                      </b>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No offline sales are waiting for review.</p>
              )}
            </section>
          </div>
          <p className="report-footnote">
            Daily totals use {data.timezone}. Currencies are reported separately. Product revenue is
            before order discounts and tax.
          </p>
        </>
      )}
      {receipt && <Receipt order={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
function SalesChart({ daily, timezone, fmt }) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 6 + i);
    const key = d.toISOString().slice(0, 10);
    return {
      key,
      label: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      value: Number(daily.find((x) => x.day === key)?.revenue || 0),
    };
  });
  const max = Math.max(1, ...days.map((d) => d.value));
  return (
    <div className="sales-chart" aria-label="Seven day revenue chart">
      {days.map((d) => (
        <div className="chart-column" key={d.key}>
          <span>{fmt(d.value)}</span>
          <div className="bar-space">
            <div
              className={`chart-bar ${d.key === today ? 'today' : ''}`}
              style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }}
              title={`${d.key}: ${fmt(d.value)}`}
            />
          </div>
          <small>{d.label}</small>
        </div>
      ))}
    </div>
  );
}
