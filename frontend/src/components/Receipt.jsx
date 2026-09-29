import { Check, Clock3, Printer, Plus } from 'lucide-react';
import { Modal } from './UI';
import { money, dateTime } from '../services/api';
export default function Receipt({ order, onClose }) {
  const s = order.receipt_settings;
  const fmt = (n) => money(n, order.currency);
  const provisional =
    order.offline_pending || ['needs_review', 'rejected'].includes(order.sync_state);
  return (
    <Modal title="Order receipt" onClose={onClose}>
      <div className="receipt" id="receipt">
        <div className={`receipt-success ${provisional ? 'receipt-pending' : ''}`}>
          {provisional ? <Clock3 size={24} /> : <Check size={24} />}
        </div>
        <p className="eyebrow">
          {order.sync_state === 'needs_review'
            ? 'OFFLINE / NEEDS REVIEW'
            : order.sync_state === 'rejected'
              ? 'OFFLINE / REJECTED'
              : order.offline_pending
                ? 'OFFLINE / PENDING SYNC'
                : order.source === 'offline'
                  ? 'OFFLINE CASH · SYNCED'
                  : 'PAYMENT COMPLETE'}
        </p>
        {s.logo_url && <img className="receipt-logo" src={s.logo_url} alt="Café logo" />}
        <h2>{s.cafe_name}</h2>
        <p>
          {s.address}
          <br />
          {s.phone}
        </p>
        <div className="receipt-meta">
          <strong>{order.order_number}</strong>
          <span>{dateTime(order.created_at)}</span>
          <span>Served by {order.cashier}</span>
        </div>
        <div className="receipt-lines">
          {order.items.map((i) => (
            <div key={i.id}>
              <span>
                {i.product_name}{' '}
                <small>
                  × {i.quantity} @ {fmt(i.unit_price)}
                </small>
              </span>
              <strong>{fmt(i.subtotal)}</strong>
            </div>
          ))}
        </div>
        <div className="receipt-totals">
          <div>
            <span>Subtotal</span>
            <span>{fmt(order.subtotal)}</span>
          </div>
          <div>
            <span>Discount</span>
            <span>−{fmt(order.discount)}</span>
          </div>
          <div>
            <span>Tax ({order.tax_percentage}%)</span>
            <span>{fmt(order.tax)}</span>
          </div>
          <div className="grand-total">
            <strong>Total</strong>
            <strong>{fmt(order.total)}</strong>
          </div>
          <div>
            <span>Payment · {order.payment_method.toUpperCase()}</span>
            <span>Paid</span>
          </div>
          {order.payment_method === 'cash' && (
            <>
              <div>
                <span>Cash received</span>
                <span>{fmt(order.cash_received)}</span>
              </div>
              <div>
                <span>Change</span>
                <strong>{fmt(order.change_amount)}</strong>
              </div>
            </>
          )}
        </div>
        <p className="receipt-thanks">
          Thank you for stopping by.
          <br />
          <strong>See you for your next cup!</strong>
        </p>
      </div>
      <div className="modal-actions no-print">
        <button className="button secondary" onClick={() => window.print()}>
          <Printer size={18} /> Print Receipt
        </button>
        <button className="button" onClick={onClose}>
          <Plus size={18} /> New Order
        </button>
      </div>
    </Modal>
  );
}
