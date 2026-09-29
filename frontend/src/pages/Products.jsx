import { useState } from 'react';
import { Plus, Pencil, Trash2, Search, ImagePlus, Package } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, money } from '../services/api';
import { PageHeading, Modal, Photo, Empty } from '../components/UI';
export default function Products({ embedded = false }) {
  const { products, categories, settings, refresh, notify } = useApp();
  const [query, setQuery] = useState(''),
    [editing, setEditing] = useState(null),
    [deleting, setDeleting] = useState(null),
    [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api(`/products/${deleting.id}`, { method: 'DELETE' });
      await refresh();
      setDeleting(null);
      notify('Product removed from the menu.');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  const filtered = products.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className={embedded ? 'settings-menu' : 'page'}>
      <PageHeading
        eyebrow="YOUR CAFÉ, YOUR MENU"
        title={embedded ? 'Menu & prices' : 'Products'}
        description="Replace product photos, change prices, and choose what appears on your POS."
      >
        <button
          className="button"
          onClick={() =>
            setEditing({ name: '', price: '', category_id: categories[0]?.id, available: true })
          }
        >
          <Plus size={18} /> Add Product
        </button>
      </PageHeading>
      <div className="surface">
        <div className="table-toolbar">
          <h3>
            Menu collection <span className="count-badge">{products.length}</span>
          </h3>
          <div className="search-field">
            <Search size={18} />
            <input
              aria-label="Search products"
              placeholder="Find a product…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Price</th>
                <th>Availability</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="table-product">
                      <Photo src={p.image_url} alt={p.name} />
                      <strong>{p.name}</strong>
                    </div>
                  </td>
                  <td>{p.category}</td>
                  <td className="price">{money(p.price, settings.currency)}</td>
                  <td>
                    <span className={`status ${p.available ? '' : 'unavailable'}`}>
                      {p.available ? 'Available' : 'Unavailable'}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="button secondary product-edit-button"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => setEditing(p)}
                      >
                        <Pencil size={17} />
                        <span>Edit price & photo</span>
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={`Delete ${p.name}`}
                        onClick={() => setDeleting(p)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty
            icon={Package}
            title="No products here yet"
            description="Add a product or try a different search."
          />
        )}
      </div>
      {editing && <ProductForm product={editing} onClose={() => setEditing(null)} />}{' '}
      {deleting && (
        <Modal title="Remove product?" onClose={() => !busy && setDeleting(null)}>
          <div className="modal-body">
            <p>
              Remove <strong>{deleting.name}</strong> from your menu? Its past sales and receipts
              will be preserved.
            </p>
            <div className="modal-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button className="button danger-button" disabled={busy} onClick={remove}>
                {busy ? 'Removing…' : 'Delete Product'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ProductForm({ product, onClose }) {
  const { categories, refresh, notify } = useApp();
  const [form, setForm] = useState({ ...product }),
    [file, setFile] = useState(null),
    [preview, setPreview] = useState(product.image_url),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const change = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  function choose(e) {
    const f = e.target.files[0];
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 5 * 1024 * 1024) {
      setError('Choose a JPG, PNG, or WEBP photo no larger than 5 MB.');
      e.target.value = '';
      return;
    }
    setError('');
    setFile(f);
    if (f) {
      const reader = new FileReader();
      reader.onload = () => setPreview(reader.result);
      reader.readAsDataURL(f);
    }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData();
    for (const key of ['name', 'price', 'category_id', 'available']) data.append(key, form[key]);
    if (file) data.append('image', file);
    try {
      await api(`/products${product.id ? `/${product.id}` : ''}`, {
        method: product.id ? 'PUT' : 'POST',
        body: data,
      });
      await refresh();
      notify(
        product.id
          ? 'Product updated. Your POS menu is up to date.'
          : 'Product added to your menu.',
      );
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={product.id ? 'Edit Product' : 'Add Product'} onClose={() => !busy && onClose()}>
      <form className="form-grid modal-body" onSubmit={save}>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <label>
          Product name
          <input
            required
            maxLength={120}
            value={form.name}
            onChange={(e) => change('name', e.target.value)}
            placeholder="e.g. Cappuccino"
          />
        </label>
        <div className="form-columns">
          <label>
            Price
            <input
              type="number"
              min="0"
              max="100000"
              step="0.01"
              required
              value={form.price}
              onChange={(e) => change('price', e.target.value)}
            />
          </label>
          <label>
            Category
            <select
              aria-label="Category"
              required
              value={form.category_id}
              onChange={(e) => change('category_id', e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="upload-preview">
          <Photo src={preview} alt="Product preview" />
          <div>
            <strong>
              {file ? 'New photo preview' : product.id ? 'Current photo' : 'Product photo'}
            </strong>
            <p>JPG, PNG or WEBP · up to 5 MB</p>
            <label className="upload-label">
              <ImagePlus size={16} />
              {product.id ? 'Replace photo' : 'Choose photo'}
              <input
                aria-label="Product image"
                type="file"
                accept=".jpg,.jpeg,.png,.webp"
                onChange={choose}
              />
            </label>
            {file && <small>{file.name}</small>}
          </div>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={form.available}
            onChange={(e) => change('available', e.target.checked)}
          />
          <span>Available on the POS menu</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button" disabled={busy}>
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
