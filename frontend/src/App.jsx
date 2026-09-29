import { useEffect, useState } from 'react';
import {
  ShoppingCart,
  History,
  Package,
  ChartNoAxesCombined,
  Settings as SettingsIcon,
  MonitorSmartphone,
  LogOut,
  Search,
  Clock,
  ChevronRight,
  Leaf,
} from 'lucide-react';
import { useApp } from './context/AppContext';
import { api } from './services/api';
import { Brand, Spinner } from './components/UI';
import Login from './pages/Login';
import POS from './pages/POS';
import Products from './pages/Products';
import Orders from './pages/Orders';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Devices from './pages/Devices';
import OfflineCatalog from './pages/OfflineCatalog';
import SyncStatus from './components/SyncStatus';
export default function App() {
  const { user, setUser, loading, settings, notify, refresh, offlineCatalog, posStatus } = useApp();
  const [page, setPage] = useState('pos'),
    [search, setSearch] = useState(''),
    [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setPage('pos');
  }, [user?.id]);
  if (loading) return <Spinner />;
  if (!user) {
    if (
      offlineCatalog &&
      posStatus.server !== 'reachable' &&
      ['verified', 'stale'].includes(posStatus.catalog) &&
      ['valid', 'expiring'].includes(posStatus.lease)
    )
      return <OfflineCatalog />;
    return <Login />;
  }
  if (!settings)
    return (
      <div>
        <Spinner />
        <button
          className="button"
          onClick={() => refresh().catch((e) => notify(e.message, 'error'))}
        >
          Retry loading café
        </button>
      </div>
    );
  const nav = [
    ['pos', 'POS', ShoppingCart],
    ['orders', 'Orders', History],
    ...(user.role === 'admin'
      ? [
          ['products', 'Products', Package],
          ['reports', 'Sales Report', ChartNoAxesCombined],
          ['settings', 'Settings', SettingsIcon],
          ['devices', 'POS Devices', MonitorSmartphone],
        ]
      : []),
  ];
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
      setUser(null);
    } catch (e) {
      notify(e.message, 'error');
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand settings={settings} />
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {nav.map(([id, label, Icon]) => (
            <button
              aria-label={label}
              title={label}
              className={page === id ? 'active' : ''}
              key={id}
              onClick={() => setPage(id)}
            >
              <Icon size={20} />
              <span>{label}</span>
              {page === id && <ChevronRight className="nav-arrow" size={15} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-art">
            <Leaf size={54} strokeWidth={1} />
            <p>
              Good coffee.
              <br />
              Brighter people.
            </p>
            <span>A little joy in every cup.</span>
          </div>
          <button className="logout" onClick={logout}>
            <LogOut size={18} /> Logout
          </button>
          <div className="sidebar-version">
            <i /> Café POS <span>v1.0</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="search-field top-search">
            <Search size={19} />
            <input
              aria-label="Search menu items"
              placeholder="Search menu items…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage('pos');
              }}
            />
            <kbd>⌕</kbd>
          </div>
          <div className="topbar-right">
            <div className="clock">
              <span>
                {now.toLocaleDateString('en-GB', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
              <span>
                <Clock size={13} />
                {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <SyncStatus />
            <div className="employee">
              <div className="avatar">
                {user.name
                  .split(' ')
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join('')}
              </div>
              <div>
                <strong>{user.name}</strong>
                <small>{user.role === 'admin' ? 'Admin / Owner' : 'Cashier'}</small>
              </div>
            </div>
          </div>
        </header>
        <div hidden={page !== 'pos'}>
          <POS search={search} />
        </div>
        {page === 'orders' && <Orders />}
        {user.role === 'admin' && page === 'products' && <Products />}
        {user.role === 'admin' && page === 'reports' && <Reports />}
        {user.role === 'admin' && page === 'settings' && <Settings />}
        {user.role === 'admin' && page === 'devices' && <Devices />}
      </main>
    </div>
  );
}
