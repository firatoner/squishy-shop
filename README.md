# Squishy Shop

İki ayrı hesapla ortak stok, satış ve kasa takibi. Next.js uygulaması Vercel’de, ortak veritabanı Supabase’de çalışır.

## Kurulum ve yayın

1. [Supabase SQL Editor](https://supabase.com/dashboard/projects) üzerinden `supabase/migrations/` klasöründeki SQL dosyalarını tarih sırasıyla birer kez çalıştırın. Alternatif olarak bağlı Supabase projesinde bekleyen geçişleri CLI ile uygulayın. Mevcut kurulumda yeni sürümü yayına almadan önce bekleyen geçişleri uygulayın. Platform fiyatları geçişi mevcut ürün fiyatını her iki platforma kopyalar.
2. Kaynak dosyaları özel Git deponuza ekleyin. Vercel’de projeyi Next.js olarak içe aktarın ve Node.js 22 veya üstünü seçin.
3. **Settings → Environment Variables** altında Production için bu değişkenleri ekleyin. Preview ortamında ayrı bir test Supabase projesi kullanın.

| Değişken | Değer |
| --- | --- |
| `SUPABASE_URL` | Supabase proje adresi, örneğin `https://proje-ref.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase Dashboard → Settings → API Keys altındaki sunucu anahtarı (`sb_secret_…`). Eski projeler için `SUPABASE_SERVICE_ROLE_KEY` da desteklenir. |
| `SHOP_SETUP_TOKEN` | İlk kurulum için parola yöneticisiyle oluşturacağınız en az 24 karakterli rastgele anahtar. |

4. Değişkenler eklendikten sonra yeni bir dağıtım oluşturun. **Settings → Domains** altında alan adınızı ekleyin. Vercel’in gösterdiği DNS kayıtlarını alan adı sağlayıcınızda uygulayın.
5. İlk ekranda **Kurulumu başlat** seçeneğini açın. Kurulum anahtarını ve iki farklı kullanıcı adıyla iki ayrı parolayı girin. Her parola 12–128 karakter olmalı. Her kişi kendi hesabıyla oturum açar. İki hesap aynı stok, satış ve kasa kayıtlarını görür.
6. İlk kurulum tamamlandığında yeniden kurulum yapılamaz. Kurulum anahtarını Vercel’den kaldırabilirsiniz. Anahtarları kaynak koduna eklemeyin.

## İşlemler

- Ürün kartına fotoğraf, ayrı Dolap ve Gardrops liste fiyatları ve düşük stok eşiği girin. Koli kaydındaki adet × birim maliyet toplamı koli tutarıyla eşleşmelidir. Stok teslim kaydıyla artar, kasa gerçek ödeme günü azalır. Ödeme daha sonra ilgili koliye kaydedilebilir.
- Satış eklerken Dolap veya Gardrops’u seçin. Anlaşılan birim fiyat seçilen platformun liste fiyatıyla dolar ve düzenlenebilir. Liste fiyatı, indirim ve FIFO maliyeti satış anında sabitlenir. Satılan son ürün için eşzamanlı iki kayıttan yalnızca biri kabul edilir.
- İptal ayrılan adedi stoğa döndürür. İadede satılabilir adedi her ürün için ayrı girin. Satılabilir sıfır adet stoğu değiştirmez. Diğer platformdaki ilanı manuel kontrol edin.
- Beklenen tahsilat satış tutarından platform kesintisi düşülerek hesaplanır. Sipariş kârı hesaplanırken satıcıya ait kargo, paketleme ve ürün maliyeti de düşülür. Örneğin 550 TL satış, 40 TL kesinti, 200 TL maliyet ve 10 TL paketleme için beklenen ödeme 510 TL, kâr 300 TL’dir.
- Kasa hareketi için platform ödemesinin tarihini, gerçek tutarını ve alan hesabı girin. İptal veya iade önceki gerçek tahsilatı silmez. Gerçekleşen ayrı bir iade ödemesini ilgili notla gider olarak kaydedin. İptal ve iadeler aktif satış toplamından çıkar.
- Kasa ve Giderler ekranından tahsilatları, stok ödemelerini ve genel giderleri düzenleyin veya silin. Bir stok ödemesinin tarihi ve ödeyen hesabı düzenlenebilir. Tahsilatı ya da stok ödemesini silmek, ilgili satış ya da alımın ödeme kaydını kaldırır.
- Ürün kartında ilk ortağın payını tam yüzde olarak girin. İkinci ortağa kalan pay otomatik hesaplanır. Yeni satışlar satış anındaki payı saklar. Geçmiş satışların eksik oranı sipariş detayında tamamlanabilir.
- Ortaklar ekranı dönemin ürün kârlarını, gerçekleşen tahsilatları, ödenen giderleri ve ortaklar arası bakiyeyi gösterir. Siparişin toplam kesintisi, kargosu ve paketlemesi ürünlere satış tutarlarına göre dağıtılır. Tamamı bedelsiz siparişlerde dağıtım adede göre yapılır.
- Ortaklar arası bakiye, bitiş tarihine kadar gerçekleşen tahsilatları ve ödenen FIFO maliyetlerini ürün oranıyla bölüştürür. Satılan stokun maliyeti ödeyen ortağa yazılır. Stok ödemesi, tahsilatı veya oranı eksik siparişler tamamlanana kadar bekler. İptal ve iadeler bölüşüm dışında tutulur. Kargo ve paketleme gibi fiili harcamalar, kasa giderine ortaklık payı girildiğinde bakiyeye yansır. Yapılan transferi Ortaklar ekranında kaydedin.
- Paketleme gideri sipariş kârında hesaba katılır. Gerçek bir paketleme ödemesini genel gider olarak kaydetmek kasayı etkiler. Koli ödemeleri kasa hareketidir ve sipariş kârından ayrıca düşülmez.
- Raporlarda satış, stok hareketi ve gider için başlangıç ve bitiş tarihini seçip Excel uyumlu CSV alın.

## Yerel geliştirme ve kontroller

```sh
npm ci
npm run dev
npm run typecheck
npm run build
npm test
```

Yerel çalıştırma için `.env.example` dosyasını `.env.local` olarak kopyalayıp ayrı bir test Supabase projesiyle doldurun. Uçtan uca test için boş test veritabanında tüm geçişleri tarih sırasıyla uygulayın ve uygulamayı başlatın. `SHOP_TEST_BASE_URL` ve `SHOP_TEST_SETUP_TOKEN` değerlerini ayarlayıp `npm run test:integration` komutunu çalıştırın. Bu test iki deneme hesabı ve test kayıtları oluşturur. `tests/shop.database.test.sql` PostgreSQL RPC iş akışını tek işlemde dener ve test satırlarını geri alır.

