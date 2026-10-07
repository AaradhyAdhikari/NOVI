import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Laptop → Settings → Pair a phone: scan with the phone camera; the link opens Novi on the phone
// and pairs it with a one-time code (5 minutes). First choice is the Tailscale address (works
// anywhere); the home Wi-Fi address is for phones without Tailscale.
export default function PairQr({ pairing }) {
  const [which, setWhich] = useState(0);
  const [img, setImg] = useState(null);
  const url = pairing.qrUrls?.[which];
  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { margin: 1, width: 240 }).then(setImg).catch(() => setImg(null));
  }, [url]);
  if (!url) return <p className="muted">No network address found for phones.</p>;
  return (
    <div className="pair-qr">
      {img && <img src={img} alt="QR code to pair a phone" width={240} height={240} />}
      <p className="muted">Scan with the phone's camera. Works once; a new code appears every 5 minutes.</p>
      {pairing.qrUrls.length > 1 && (
        <label className="row">
          Address
          <select value={which} onChange={(e) => setWhich(Number(e.target.value))}>
            {pairing.urls.map((u, i) => <option key={u} value={i}>{u.includes('.ts.net') ? 'Anywhere (Tailscale)' : `Home Wi-Fi (${new URL(u).hostname})`}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
