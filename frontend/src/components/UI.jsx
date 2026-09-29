import { useEffect, useRef } from 'react';
import { Coffee, X, LoaderCircle } from 'lucide-react';
export function Brand({ settings }) {
  return (
    <div className="brand">
      {settings?.logo_url ? (
        <img src={settings.logo_url} alt="Café logo" />
      ) : (
        <div className="brand-icon">
          <Coffee size={28} />
          <span>✦</span>
        </div>
      )}
      <div>
        <strong>{settings?.cafe_name || 'Brew & Bean'}</strong>
        <small>Good coffee. Better days.</small>
      </div>
    </div>
  );
}
export function Photo({ src, alt, ...props }) {
  return (
    <img
      src={src || '/images/coffee.svg'}
      alt={alt}
      onError={(e) => {
        e.currentTarget.onerror = null;
        e.currentTarget.src = '/images/coffee.svg';
      }}
      {...props}
    />
  );
}
export function Spinner() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={28} /> Loading your café…
    </div>
  );
}
export function Empty({ icon: Icon = Coffee, title, description }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={32} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function PageHeading({ eyebrow, title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {children}
    </div>
  );
}
