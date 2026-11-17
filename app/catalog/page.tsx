"use client";

import { useEffect, useState } from "react";

type Item = { id: number; name: string; hasPhoto: boolean; dolapListPrice: number; gardropsListPrice: number };
const money = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });

export default function Catalog() {
  const [result, setResult] = useState<{ key: string; items: Item[] } | null>();
  useEffect(() => {
    const abort = new AbortController();
    const key = new URLSearchParams(window.location.search).get("key") ?? "";
    fetch("/api/catalog?key=" + encodeURIComponent(key), { signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Katalog yüklenemedi.");
        setResult({ key, items: await response.json() });
      })
      .catch(() => { if (!abort.signal.aborted) setResult(null); });
    return () => abort.abort();
  }, []);

  return <main className="catalog-page">
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
    <h1>Squishy Shop</h1>
    <h2>Ürün kataloğu</h2>
    {result === undefined ? <p role="status">Katalog yükleniyor…</p> : result === null ? <p role="alert">Katalog açılamadı. Bağlantıyı kontrol et.</p>
      : result.items.length === 0 ? <p>Şu anda stokta ürün yok.</p>
      : <div className="product-grid">{result.items.map(item => <article className="panel catalog-item" key={item.id}>
        {item.hasPhoto && <img src={"/api/catalog-photo?key=" + encodeURIComponent(result.key) + "&id=" + item.id} alt="" loading="lazy" />}
        <h3>{item.name}</h3>
        <dl><div><dt>Dolap</dt><dd>{money.format(item.dolapListPrice / 100)}</dd></div>
          <div><dt>Gardrops</dt><dd>{money.format(item.gardropsListPrice / 100)}</dd></div></dl>
      </article>)}</div>}
  </main>;
}
