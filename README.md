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
- Stok ekranında bir alımı açıp **Düzenle** ile adı, tarihi ve ürün satırlarını güncelleyebilirsiniz. Satış geçmişi olan satırların ürünü ve birim maliyeti sabittir. Adet, satışlarda kullanılan miktarın altına düşürülemez. Adet farkları stok hareketlerinde düzeltme olarak görünür. Alım ödenmişse kasadaki mevcut ödeme tutarı da güncellenir.
- Satış eklerken Dolap veya Gardrops’u seçin. Anlaşılan birim fiyat seçilen platformun liste fiyatıyla dolar ve düzenlenebilir. Liste fiyatı, indirim ve FIFO maliyeti satış anında sabitlenir. Satılan son ürün için eşzamanlı iki kayıttan yalnızca biri kabul edilir.
- Birden çok ürüne tek teklif verildiyse satış toplamını bir kez girin. Tutar seçilen platform fiyatları ve adetlerine göre ürünlere kuruşu kuruşuna dağıtılır. Tüm liste fiyatları sıfırsa dağıtım adede göre yapılır.
- Kargo ve platform kesintisi sonrası neti doğrudan girebilirsiniz. Paketleme ve stok maliyeti kâr hesabında bu tutardan düşülür. Hesaba geçen gerçek ödeme tahsilat alanına kaydedilir.
- İptal ayrılan adedi stoğa döndürür. İadede satılabilir adedi her ürün için ayrı girin. Satılabilir sıfır adet stoğu değiştirmez. Diğer platformdaki ilanı manuel kontrol edin.
- Beklenen tahsilat satış tutarından platform kesintisi düşülerek hesaplanır. Sipariş kârı hesaplanırken satıcıya ait kargo, paketleme ve ürün maliyeti de düşülür. Örneğin 550 TL satış, 40 TL kesinti, 200 TL maliyet ve 10 TL paketleme için beklenen ödeme 510 TL, kâr 300 TL’dir.
- Kasa hareketi için platform ödemesinin tarihini, gerçek tutarını ve alan hesabı girin. İptal veya iade önceki gerçek tahsilatı silmez. Gerçekleşen ayrı bir iade ödemesini ilgili notla gider olarak kaydedin. İptal ve iadeler aktif satış toplamından çıkar.
- Kasa ve Giderler ekranından tahsilatları, stok ödemelerini ve genel giderleri düzenleyin veya silin. Bir stok ödemesinin tarihi ve ödeyen hesabı düzenlenebilir. Tahsilatı ya da stok ödemesini silmek, ilgili satış ya da alımın ödeme kaydını kaldırır.
- Stok eklerken her ürün satırının kâr payını girin. İlk ortağın yüzdesi ve ikinci ortağa kalan pay birlikte gösterilir. Aynı ürünün farklı alımlarında ayrı oranlar kullanılabilir. Satışta önce en eski alımdaki stok kullanılır ve her stokun payı satış satırında saklanır. Stok payını değiştirmek yeni satışlara uygulanır. Geçmiş satışların eksik oranı sipariş detayında ilgili alım için tamamlanabilir. Bu sürüme geçerken mevcut stoklar ürün kartındaki son kayıtlı oranı devralır.
- Paketlenecek ve paketlenmiş satışlar **Düzenle** ile güncellenebilir. Platform, tarih, referans, ürün, adet, toplam tutar, net tutar, kargo, kesinti ve paketleme değiştirilebilir. Mevcut stok bağlantıları ve payları önce kullanılır. Adet artışında kalan stok kullanılır. Yetersiz stokta işlem geri alınır. Gerçekleşmiş tahsilat Kasa ve Giderler ekranından ayrıca düzenlenebilir.
- Ürün Performansı ekranında tarih aralığı seçerek satılan adet, satış toplamı, ürün kârı ve kâr oranını inceleyin. En çok satan, en çok kâr bırakan ve en uzun bekleyen olarak sıralayın. Güncel stok ve eldeki en eski alımın yaşı ayrıca gösterilir.
- Platform Karşılaştırması ekranında seçilen tarih aralığı için Dolap ve Gardrops sipariş, adet, satış toplamı, kesinti ve kargo, paketleme, stok maliyeti, kâr ve ortalama sepetini karşılaştırın.
- Stok Yenileme ekranında son satış hızına göre hedef stoğu ve alınması önerilen adedi görün. Başlangıçta son 30 günlük satışla 14 günlük hedef hesaplanır. Her iki süre de ekranda 1–365 gün arasında değiştirilebilir. Bugün dahil aktif satışlar sayılır. Öneri, hedef stoktan eldeki adedi çıkarır ve gereken miktarı tam adede yuvarlar.
- Ortaklar ekranı dönemin ürün kârlarını, gerçekleşen tahsilatları, ödenen giderleri ve ortaklar arası bakiyeyi gösterir. Siparişin toplam kesintisi, kargosu ve paketlemesi ürünlere satış tutarlarına göre dağıtılır. Tamamı bedelsiz siparişlerde dağıtım adede göre yapılır.
- Ortaklar arası bakiye, bitiş tarihine kadar gerçekleşen tahsilatları ve ödenen FIFO maliyetlerini ürün oranıyla bölüştürür. Satılan stokun maliyeti ödeyen ortağa yazılır. Stok ödemesi, tahsilatı veya oranı eksik siparişler tamamlanana kadar bekler. İptal ve iadeler bölüşüm dışında tutulur. Kargo ve paketleme gibi fiili harcamalar, kasa giderine ortaklık payı girildiğinde bakiyeye yansır. Yapılan transferi Ortaklar ekranında kaydedin.
- Paketleme gideri sipariş kârında hesaba katılır. Gerçek bir paketleme ödemesini genel gider olarak kaydetmek kasayı etkiler. Koli ödemeleri kasa hareketidir ve sipariş kârından ayrıca düşülmez.
- Ayarlar ekranında kutu, ambalaj, sticker ve kart için sipariş başına ortak paketleme varsayılanını belirleyin. Başlangıç tutarı 10 TL’dir. Yeni satışta bu tutar otomatik gelir ve satışa özel düzenlenebilir.
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

