import { useCallback, useEffect, useState } from 'react';
import { KeyRound, MonitorSmartphone, Plus, RefreshCw, ShieldOff } from 'lucide-react';
import { api } from '../services/api';
import { rotateThisDeviceKey } from '../offline/device';
import { getDeviceIdentity } from '../offline/database';
import { useApp } from '../context/AppContext';

const date = (value) => (value ? new Date(value).toLocaleString() : 'Never');

export default function Devices() {
  const { notify, posStatus, refreshDeviceFoundation } = useApp();
  const [devices, setDevices] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairingCode, setPairingCode] = useState(null);
  const [localIdentity, setLocalIdentity] = useState(null);

  const load = useCallback(async () => {
    const [rows, identity] = await Promise.all([api('/devices'), getDeviceIdentity()]);
    setDevices(rows);
    setLocalIdentity(identity);
  }, []);

  useEffect(() => {
    load().catch((error) => notify(error.message, 'error'));
  }, [load, notify]);

  async function createDevice(event) {
    event.preventDefault();
    setBusy(true);
    setPairingCode(null);
    try {
      const created = await api('/devices', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      setPairingCode({
        deviceName: created.name,
        code: created.pairing_code,
        expires: created.expires_at,
      });
      await load();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function issuePairingCode(device) {
    setBusy(true);
    setPairingCode(null);
    try {
      const result = await api(`/devices/${device.id}/pairing-codes`, { method: 'POST' });
      setPairingCode({
        deviceName: device.name,
        code: result.pairing_code,
        expires: result.expires_at,
      });
      await load();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device) {
    if (
      !window.confirm(
        `Revoke “${device.name}”? Its device key and catalog lease will stop working.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/devices/${device.id}`, { method: 'DELETE' });
      if (localIdentity?.device_id === device.id) {
        setLocalIdentity({ ...localIdentity, state: 'revoked' });
        await refreshDeviceFoundation();
      }
      await load();
      notify(`${device.name} was revoked.`);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey() {
    setBusy(true);
    try {
      await rotateThisDeviceKey();
      await refreshDeviceFoundation();
      await load();
      notify('This browser’s POS credential was rotated.');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page devices-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEVICE SECURITY</span>
          <h1>POS devices</h1>
          <p className="muted">
            Register tills, issue short lived pairing codes, rotate this browser’s credential, or
            revoke access.
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => load().catch((e) => notify(e.message, 'error'))}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <form className="device-create card" onSubmit={createDevice}>
        <label>
          New device name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            placeholder="Front counter"
          />
        </label>
        <button className="button" disabled={busy || !name.trim()}>
          <Plus size={17} /> Register device
        </button>
      </form>

      {pairingCode && (
        <section className="pairing-code-panel" aria-live="polite">
          <div>
            <strong>One-time code for {pairingCode.deviceName}</strong>
            <p>
              Enter this on the POS device before {date(pairingCode.expires)}. It can only be used
              once.
            </p>
          </div>
          <code>{pairingCode.code}</code>
          <button
            className="button secondary"
            onClick={() =>
              navigator.clipboard
                ?.writeText(pairingCode.code)
                .then(() => notify('Pairing code copied.'))
                .catch(() => notify('Copy the pairing code manually.', 'error'))
            }
          >
            Copy code
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss pairing code"
            onClick={() => setPairingCode(null)}
          >
            ×
          </button>
        </section>
      )}

      {localIdentity && (
        <section className="device-local card">
          <div className="device-icon">
            <KeyRound size={20} />
          </div>
          <div className="device-main">
            <strong>This browser’s device credential</strong>
            <span>
              {localIdentity.device_id} · {posStatus.device}
            </span>
          </div>
          <button
            className="button secondary"
            disabled={busy || posStatus.server !== 'reachable' || posStatus.device !== 'active'}
            onClick={rotateKey}
          >
            <RefreshCw size={16} /> Rotate key
          </button>
        </section>
      )}

      <div className="device-list">
        {devices.map((device) => (
          <article className="device-row card" key={device.id}>
            <div className="device-icon">
              <MonitorSmartphone size={21} />
            </div>
            <div className="device-main">
              <strong>{device.name}</strong>
              <span>{device.id}</span>
              <small>
                Created {date(device.created_at)} · Last used {date(device.last_seen_at)}
              </small>
            </div>
            <span className={`device-state state-${device.status}`}>{device.status}</span>
            <div className="device-actions">
              {device.status !== 'revoked' && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => issuePairingCode(device)}
                >
                  New pairing code
                </button>
              )}
              {device.status !== 'revoked' && (
                <button
                  className="button danger-button"
                  disabled={busy}
                  onClick={() => revoke(device)}
                >
                  <ShieldOff size={16} /> Revoke
                </button>
              )}
            </div>
          </article>
        ))}
        {!devices.length && (
          <div className="empty">
            <h3>No POS devices registered</h3>
            <p>Register a device above to create its one-time enrollment code.</p>
          </div>
        )}
      </div>
      <p className="device-security-note">
        Device credentials only authorize catalog bootstrap and read-only catalog leases. They do
        not sign in a cashier or administrator.
      </p>
    </div>
  );
}
