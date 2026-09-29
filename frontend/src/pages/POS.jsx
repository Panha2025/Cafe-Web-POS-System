import { useEffect, useRef, useState } from 'react';
import {
  Banknote,
  CreditCard,
  QrCode,
  Trash2,
  Plus,
  Minus,
  X,
  ArrowRight,
  ShoppingBag,
  Flame,
  Coffee,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, money } from '../services/api';
import { Empty, Modal, Photo } from '../components/UI';
import Receipt from '../components/Receipt';
import { getOfflineSaleAuthorization } from '../offline/device';
import { createOfflineCashSale } from '../offline/orders';
const methods = [
  ['cash', 'Cash', Banknote],
  ['khqr', 'KHQR', QrCode],
  ['card', 'Card', CreditCard],
];
export default function POS({ search, offlineOnly = false }) {
  const {
    products,
    categories,
    settings,
    refresh,
    ensureLiveServer,
    posStatus,
    outboxStatus,
    refreshOutboxStatus,
    notify,
  } = useApp();
  const [category, setCategory] = useState('All'),
    [cart, setCart] = useState([]),
    [discount, setDiscount] = useState(''),
    [method, setMethod] = useState('cash'),
    [payment, setPayment] = useState(false),
    [received, setReceived] = useState(''),
    [busy, setBusy] = useState(false),
    [offlinePayment, setOfflinePayment] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState(null);
  const requestId = useRef(null);
  const fmt = (n) => money(n, settings.currency);
  const canUseOfflineCash =
    posStatus.device === 'active' &&
    posStatus.offlineSales &&
    posStatus.catalog === 'verified' &&
    posStatus.storage === 'available' &&
    !posStatus.clockRollback;
  useEffect(() => {
    setCart((old) =>
      old
        .map((i) => {
          const p = products.find((p) => p.id === i.id && p.available);
          return p ? { ...p, quantity: i.quantity } : null;
        })
        .filter(Boolean),
    );
  }, [products]);
  const subtotalCents = cart.reduce(
    (sum, i) => sum + Math.round(Number(i.price) * 100) * i.quantity,
    0,
  );
  const discountCents = Math.round(Number(discount || 0) * 100);
  const taxCents = Math.round(
    ((subtotalCents - discountCents) * Number(settings.tax_percentage)) / 100,
  );
  const totalCents = subtotalCents - discountCents + taxCents;
  const total = totalCents / 100;
  const count = cart.reduce((sum, i) => sum + i.quantity, 0);
  const checkoutSignature = JSON.stringify([
    cart.map((i) => [i.id, i.quantity, i.price]),
    discount,
    method,
    received,
    settings.tax_percentage,
  ]);
  useEffect(() => {
    requestId.current = null;
  }, [checkoutSignature]);
  useEffect(() => {
    if (!receipt?.request_id) return;
    const saved = outboxStatus.orders.find((record) => record.request_id === receipt.request_id);
    if (saved?.provisional_receipt) setReceipt(saved.provisional_receipt);
  }, [outboxStatus.orders, receipt?.request_id]);
  function add(p) {
    setCart((old) => {
      const exists = old.find((i) => i.id === p.id);
      return exists
        ? old.map((i) => (i.id === p.id ? { ...i, quantity: Math.min(i.quantity + 1, 999) } : i))
        : [...old, { ...p, quantity: 1 }];
    });
  }
  function quantity(id, delta) {
    setCart((old) =>
      old
        .map((i) => (i.id === id ? { ...i, quantity: Math.min(999, i.quantity + delta) } : i))
        .filter((i) => i.quantity > 0),
    );
  }
  async function beginPayment() {
    if (!cart.length) return;
    if (!Number.isFinite(discountCents) || discountCents < 0 || discountCents > subtotalCents) {
      notify('Discount must be between zero and the subtotal.', 'error');
      return;
    }
    if (offlineOnly) {
      setError('');
      setReceived('');
      setOfflinePayment(true);
      setPayment(true);
      return;
    }
    try {
      await ensureLiveServer();
      await refresh();
      setError('');
      setReceived('');
      setOfflinePayment(false);
      setPayment(true);
    } catch (e) {
      if (method === 'cash' && canUseOfflineCash) {
        setError('');
        setReceived('');
        setOfflinePayment(true);
        setPayment(true);
        return;
      }
      notify(e.message, 'error');
    }
  }
  async function complete(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    requestId.current ||= crypto.randomUUID();
    try {
      let liveServer = false;
      if (!offlineOnly) {
        try {
          await ensureLiveServer();
          liveServer = true;
        } catch {
          liveServer = false;
        }
      }
      if (liveServer) {
        const order = await api('/orders', {
          method: 'POST',
          body: JSON.stringify({
            request_id: requestId.current,
            items: cart.map((i) => ({
              product_id: i.id,
              quantity: i.quantity,
              expected_price: Number(i.price),
            })),
            discount: Number(discount || 0),
            expected_total: total,
            payment_method: method,
            ...(method === 'cash' ? { cash_received: Number(received) } : {}),
            confirmed: true,
          }),
        });
        setReceipt(order);
      } else {
        if (method !== 'cash') throw new Error('Card and KHQR checkout require a live server.');
        const authorization = await getOfflineSaleAuthorization();
        const provisional = await createOfflineCashSale({
          authorization,
          items: cart,
          discount: Number(discount || 0),
          cashReceived: Number(received),
        });
        setReceipt(provisional);
        await refreshOutboxStatus();
      }
      setPayment(false);
      setCart([]);
      setDiscount('');
      requestId.current = null;
    } catch (e) {
      setError(e.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  if (offlineOnly && !canUseOfflineCash)
    return (
      <section className="offline-readonly-message">
        <h2>Offline cash checkout is unavailable</h2>
        <p>A verified menu, persistent storage, and a valid offline cash lease are required.</p>
      </section>
    );
  const visible = products.filter(
    (p) =>
      p.available &&
      (category === 'All' || p.category === category) &&
      p.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="pos-layout">
      <section className="menu-section">
        <div className="menu-intro">
          <div>
            <p className="eyebrow">LET’S MAKE SOMETHING GOOD</p>
            <h1>Fresh picks, happy people.</h1>
          </div>
          <span className="menu-count">
            {products.filter((p) => p.available).length} items on the menu
          </span>
        </div>
        <div className="category-tabs">
          {['All', ...categories.map((c) => c.name)].map((c) => (
            <button
              key={c}
              className={category === c ? 'active' : ''}
              onClick={() => setCategory(c)}
            >
              {c === 'All' && <Coffee size={16} />} {c}
            </button>
          ))}
        </div>
        <div className="product-grid">
          {visible.map((p) => (
            <button
              className={`product-card ${cart.some((i) => i.id === p.id) ? 'selected' : ''}`}
              key={p.id}
              onClick={() => add(p)}
              aria-label={`Add ${p.name}`}
            >
              <div className="product-photo">
                <Photo src={p.image_url} alt={p.name} />
                {cart.some((i) => i.id === p.id) && (
                  <span className="product-quantity">
                    {cart.find((i) => i.id === p.id).quantity}
                  </span>
                )}
                <span className="product-add">
                  <Plus size={18} />
                </span>
              </div>
              <div className="product-info">
                <small>{p.category}</small>
                <h3>{p.name}</h3>
                <strong>{fmt(p.price)}</strong>
              </div>
            </button>
          ))}
        </div>
        {!visible.length && (
          <Empty title="No items found" description="Try another search or category." />
        )}
        <section className="popular">
          <h3>
            <Flame size={18} /> Café favorites <span>A little inspiration for your order</span>
          </h3>
          <div className="popular-grid">
            {products
              .filter(
                (p) =>
                  p.available &&
                  ['Cappuccino', 'Latte', 'Matcha Latte', 'Croissant'].includes(p.name),
              )
              .slice(0, 4)
              .map((p) => (
                <button key={p.id} onClick={() => add(p)}>
                  <Photo src={p.image_url} alt="" />
                  <div>
                    <strong>{p.name}</strong>
                    <span>{fmt(p.price)}</span>
                  </div>
                  <Plus size={16} />
                </button>
              ))}
          </div>
        </section>
        <div className="menu-footer">
          <span>
            <i />{' '}
            {posStatus.server === 'reachable'
              ? 'Server connected · checkout online'
              : 'Checkout requires a live server'}
          </span>
          <span>Made with care. Served with a smile.</span>
        </div>
      </section>
      <aside className="order-panel">
        <div className="order-header">
          <div>
            <h2>
              Current Order <span>{count}</span>
            </h2>
            <p>Good things are brewing.</p>
          </div>
          <button
            className="clear-button"
            onClick={() => {
              setCart([]);
              setDiscount('');
            }}
            disabled={!cart.length}
          >
            <Trash2 size={15} /> Clear All
          </button>
        </div>
        <div className="cart-items">
          {cart.length ? (
            cart.map((i) => (
              <div className="cart-item" key={i.id}>
                <Photo src={i.image_url} alt="" />
                <div className="cart-item-info">
                  <strong>{i.name}</strong>
                  <span>{fmt(i.price)}</span>
                  <div className="quantity-control">
                    <button aria-label={`Decrease ${i.name}`} onClick={() => quantity(i.id, -1)}>
                      <Minus size={13} />
                    </button>
                    <b aria-label={`${i.name} quantity`}>{i.quantity}</b>
                    <button
                      aria-label={`Increase ${i.name}`}
                      onClick={() => quantity(i.id, 1)}
                      disabled={i.quantity >= 999}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                </div>
                <div className="cart-item-end">
                  <button
                    aria-label={`Remove ${i.name}`}
                    onClick={() => setCart((old) => old.filter((p) => p.id !== i.id))}
                  >
                    <X size={16} />
                  </button>
                  <strong>{fmt(Number(i.price) * i.quantity)}</strong>
                </div>
              </div>
            ))
          ) : (
            <Empty
              icon={ShoppingBag}
              title="Your next great order"
              description="Tap an item on the menu to get started."
            />
          )}
        </div>
        <div className="checkout">
          <div className="totals">
            <div>
              <span>Subtotal</span>
              <strong>{fmt(subtotalCents / 100)}</strong>
            </div>
            <div>
              <label htmlFor="discount">
                Discount <small>amount</small>
              </label>
              <input
                id="discount"
                aria-label="Discount amount"
                type="number"
                min="0"
                max={subtotalCents / 100}
                step="0.01"
                placeholder="0.00"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </div>
            <div>
              <span>Tax ({Number(settings.tax_percentage)}%)</span>
              <span>{fmt(Math.max(0, taxCents) / 100)}</span>
            </div>
            <div className="grand-total">
              <strong>Total</strong>
              <strong data-testid="order-total">{fmt(Math.max(0, total))}</strong>
            </div>
          </div>
          <h3 className="payment-label">Payment Method</h3>
          <div className={`payment-methods ${offlineOnly ? 'cash-only' : ''}`}>
            {methods
              .filter(([id]) => !offlineOnly || id === 'cash')
              .map(([id, label, Icon]) => (
                <button
                  key={id}
                  className={method === id ? 'active' : ''}
                  onClick={() => setMethod(id)}
                  disabled={id !== 'cash' && posStatus.server !== 'reachable'}
                >
                  <Icon size={23} />
                  {label}
                </button>
              ))}
          </div>
          <button
            className="button checkout-button"
            disabled={!cart.length || (posStatus.server !== 'reachable' && !canUseOfflineCash)}
            onClick={beginPayment}
          >
            Proceed to Payment <ArrowRight size={21} />
          </button>
          <p className="checkout-note">A great day begins with a great cup.</p>
        </div>
      </aside>
      {payment && (
        <Modal
          title={
            offlinePayment
              ? 'Offline cash sale'
              : `Complete ${method === 'khqr' ? 'KHQR' : method} payment`
          }
          onClose={() => {
            if (!busy) setPayment(false);
          }}
        >
          <form onSubmit={complete} className="payment-form">
            <p className="muted">
              {count} items · Review the amount before confirming.
              {offlinePayment && (
                <strong className="offline-pending-note"> Offline / pending sync.</strong>
              )}
            </p>
            <div className="amount-due">
              <span>Amount to Pay</span>
              <strong>{fmt(total)}</strong>
            </div>
            {error && (
              <div role="alert" className="form-error">
                {error}
              </div>
            )}
            {method === 'cash' ? (
              <>
                <label>
                  Cash received
                  <input
                    autoFocus
                    type="number"
                    min={total}
                    max="100000"
                    step="0.01"
                    required
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <div className="quick-cash">
                  {[total, Math.ceil(total / 5) * 5 + 5, Math.ceil(total / 10) * 10 + 10].map(
                    (n, index) => (
                      <button type="button" key={index} onClick={() => setReceived(String(n))}>
                        {index === 0 ? 'Exact amount' : fmt(n)}
                      </button>
                    ),
                  )}
                </div>
                <div className="change-row">
                  <span>Change</span>
                  <strong data-testid="change">
                    {fmt(Math.max(0, Number(received || 0) - total))}
                  </strong>
                </div>
              </>
            ) : method === 'khqr' ? (
              <>
                {settings.khqr_url ? (
                  <img
                    className="khqr-image"
                    src={settings.khqr_url}
                    alt="Café KHQR payment code"
                  />
                ) : (
                  <div className="form-error">
                    No KHQR image yet. Ask the owner to upload one in Settings.
                  </div>
                )}
                <p className="payment-explainer">
                  Check your café’s bank app and confirm the full amount has arrived. This system
                  does not verify bank transfers.
                </p>
              </>
            ) : (
              <div className="terminal-note">
                <CreditCard size={40} />
                <h3>Use your card terminal</h3>
                <p>
                  Charge {fmt(total)} on the external terminal. Confirm below only after the
                  terminal shows an approved payment.
                </p>
              </div>
            )}
            <button
              className="button full"
              disabled={
                busy ||
                !cart.length ||
                (method === 'cash' && (received === '' || Number(received) < total)) ||
                (method === 'khqr' && !settings.khqr_url)
              }
            >
              {busy
                ? 'Saving order…'
                : offlinePayment
                  ? 'Save offline cash sale'
                  : method === 'khqr'
                    ? 'Payment Received'
                    : method === 'card'
                      ? 'Confirm Card Payment'
                      : 'Confirm Payment'}
              <ArrowRight size={18} />
            </button>
          </form>
        </Modal>
      )}
      {receipt && <Receipt order={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
