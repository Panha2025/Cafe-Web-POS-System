import { useState } from 'react';
import { Save, Store, QrCode, ImagePlus, Package } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { PageHeading, Photo } from '../components/UI';
import Products from './Products';
export default function Settings() {
  const { settings, refresh, notify } = useApp();
  const [section, setSection] = useState('cafe'),
    [form, setForm] = useState({ ...settings }),
    [files, setFiles] = useState({}),
    [previews, setPreviews] = useState({ logo: settings.logo_url, khqr: settings.khqr_url }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const change = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  function choose(key, file) {
    if (!file) return;
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      setError('Choose a JPG, PNG, or WEBP image no larger than 5 MB.');
      return;
    }
    setError('');
    setFiles((f) => ({ ...f, [key]: file }));
    if (file) {
      const reader = new FileReader();
      reader.onload = () => setPreviews((p) => ({ ...p, [key]: reader.result }));
      reader.readAsDataURL(file);
    }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData();
    for (const key of ['cafe_name', 'address', 'phone', 'currency', 'tax_percentage'])
      data.append(key, form[key]);
    for (const [key, file] of Object.entries(files)) if (file) data.append(key, file);
    try {
      const saved = await api('/settings', { method: 'PUT', body: data });
      setPreviews({ logo: saved.logo_url, khqr: saved.khqr_url });
      setFiles({});
      await refresh();
      notify('Settings saved. New orders and receipts will use these details.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page settings-page">
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="Café Settings"
        description="The details that make this café yours."
      />
      <div className="settings-sections" role="group" aria-label="Settings sections">
        <button type="button" aria-pressed={section === 'cafe'} onClick={() => setSection('cafe')}>
          <Store size={18} /> Café details & images
        </button>
        <button type="button" aria-pressed={section === 'menu'} onClick={() => setSection('menu')}>
          <Package size={18} /> Menu & prices
        </button>
      </div>
      <div hidden={section !== 'cafe'}>
        <form onSubmit={save}>
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
          <div className="settings-grid">
            <section className="surface settings-card">
              <div className="section-heading">
                <div>
                  <h3>
                    <Store size={19} /> Café details
                  </h3>
                  <p>Shown on your POS and printed receipts.</p>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Café name
                  <input
                    required
                    maxLength={120}
                    value={form.cafe_name}
                    onChange={(e) => change('cafe_name', e.target.value)}
                  />
                </label>
                <label>
                  Address
                  <textarea
                    aria-label="Address"
                    maxLength={500}
                    value={form.address}
                    onChange={(e) => change('address', e.target.value)}
                  />
                </label>
                <label>
                  Phone number
                  <input
                    maxLength={40}
                    value={form.phone}
                    onChange={(e) => change('phone', e.target.value)}
                  />
                </label>
                <div className="form-columns">
                  <label>
                    Currency
                    <select
                      aria-label="Currency"
                      value={form.currency}
                      onChange={(e) => change('currency', e.target.value)}
                    >
                      {['USD', 'KHR', 'EUR', 'GBP', 'THB'].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Tax percentage
                    <input
                      required
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={form.tax_percentage}
                      onChange={(e) => change('tax_percentage', e.target.value)}
                    />
                  </label>
                </div>
                <p className="field-help">
                  Tax is applied after discounts. Changing currency changes the unit for new sales;
                  it does not convert menu prices. Past receipts keep their original currency and
                  café details.
                </p>
              </div>
            </section>
            <div className="settings-uploads">
              {[
                ['logo', 'Café logo', 'Your brand, front and center.', ImagePlus],
                [
                  'khqr',
                  'KHQR payment image',
                  'Upload your café’s bank-issued KHQR image.',
                  QrCode,
                ],
              ].map(([key, title, note, Icon]) => (
                <section className="surface settings-card" key={key}>
                  <h3>
                    <Icon size={19} />
                    {title}
                  </h3>
                  <p className="muted">{note}</p>
                  <div className={`settings-upload ${key}`}>
                    {previews[key] ? (
                      <Photo src={previews[key]} alt={`${title} preview`} />
                    ) : (
                      <div className="image-placeholder">
                        <Icon size={35} />
                        <span>No image uploaded</span>
                      </div>
                    )}
                    <label className="upload-label">
                      <ImagePlus size={16} />
                      {previews[key] ? 'Replace' : 'Choose'}{' '}
                      {key === 'khqr' ? 'KHQR image' : 'logo'}
                      <input
                        aria-label={key === 'khqr' ? 'KHQR image' : 'Café logo'}
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp"
                        onChange={(e) => choose(key, e.target.files[0])}
                      />
                    </label>
                    <small>{files[key]?.name || 'JPG, PNG or WEBP · up to 5 MB'}</small>
                  </div>
                </section>
              ))}
            </div>
          </div>
          <div className="settings-save">
            <p>Changes sync to open POS screens within 15 seconds.</p>
            <button className="button" disabled={busy}>
              <Save size={18} />
              {busy ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
      {section === 'menu' && <Products embedded />}
    </div>
  );
}
