import { useState } from 'react';
import { ArrowRight, Coffee, Eye, EyeOff } from 'lucide-react';
import { Brand } from '../components/UI';
import { api } from '../services/api';
import { useApp } from '../context/AppContext';
import { enrollThisDevice } from '../offline/device';
import SyncStatus from '../components/SyncStatus';
export default function Login() {
  const { setUser, refreshDeviceFoundation, notify } = useApp();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [show, setShow] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pairingCode, setPairingCode] = useState(''),
    [deviceError, setDeviceError] = useState(''),
    [deviceBusy, setDeviceBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setUser(
        await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function enrollDevice(e) {
    e.preventDefault();
    setDeviceBusy(true);
    setDeviceError('');
    try {
      await enrollThisDevice(pairingCode.trim());
      setPairingCode('');
      await refreshDeviceFoundation();
      notify(
        'This browser is enrolled as a POS device. Sign in with a cashier account to continue.',
      );
    } catch (e) {
      setDeviceError(e.message);
    } finally {
      setDeviceBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <Brand />
        <div className="login-story-copy">
          <span className="pill">MADE FOR YOUR DAILY GRIND</span>
          <h1>
            A little coffee.
            <br />A lot of possibility.
          </h1>
          <p>
            Your menu, your team, your everyday.
            <br />
            One simple space to bring it all together.
          </p>
          <div className="login-coffee">
            <Coffee size={100} strokeWidth={1} />
            <span>
              Fresh starts
              <br />
              served daily.
            </span>
          </div>
        </div>
        <small>BREW & BEAN · CAFÉ POINT OF SALE</small>
      </section>
      <section className="login-form-wrap">
        <div className="login-status">
          <SyncStatus />
        </div>
        <div className="login-form">
          <form onSubmit={submit}>
            <span className="eyebrow">WELCOME BACK</span>
            <h2>Ready for a great day?</h2>
            <p className="muted">Sign in to open your café workspace.</p>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <label>
              Email address
              <input
                type="email"
                autoComplete="username"
                required
                placeholder="you@cafepos.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <div className="password-input">
                <input
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={show ? 'Hide password' : 'Show password'}
                  onClick={() => setShow(!show)}
                >
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <button className="button login-submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight size={19} />
            </button>
          </form>
          <details className="device-enrollment">
            <summary>Set up this POS device</summary>
            <form onSubmit={enrollDevice}>
              <p>
                Enter the one-time pairing code created by an administrator. This only registers
                this browser and does not sign in a cashier.
              </p>
              {deviceError && (
                <div className="form-error" role="alert">
                  {deviceError}
                </div>
              )}
              <label>
                One-time pairing code
                <input
                  autoComplete="off"
                  spellCheck="false"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                  required
                  maxLength={120}
                />
              </label>
              <button className="button secondary" disabled={deviceBusy || !pairingCode.trim()}>
                {deviceBusy ? 'Enrolling…' : 'Enroll device'}
              </button>
            </form>
          </details>
          <div className="demo-note">
            <strong>First time here?</strong>
            <p>Demo accounts are listed in the project README.</p>
          </div>
          <small className="login-footnote">A smoother shift starts here.</small>
        </div>
      </section>
    </div>
  );
}
