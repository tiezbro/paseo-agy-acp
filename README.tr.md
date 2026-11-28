# paseo-agy-acp

[English](./README.md) | [中文](./README.zh-CN.md) | [Türkçe](./README.tr.md) | [Changelog](./CHANGELOG.md)

`paseo-agy-acp`, Paseo'yu Google'ın bağımsız Antigravity ACP çekirdeğine bağlar. [En son kararlı sürüm (`2.11.1`)](https://github.com/tiezbro/paseo-agy-acp/releases/tag/v2.11.1), [Google'ın `agy_acp_server` `1.5.2`](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/ensure-managed-kernel.ts#L18) sürümünü sabitler. Yönetilen Linux x86_64 kurulumları bir uyumluluk katmanı ekler. Paseo'da herhangi bir değişiklik gerekmez.

<!-- readme:positioning -->
## Amaç

`paseo-agy-acp`'yi çalıştırmak için Paseo'da **Antigravity Pro**'yu seçin. Yerleşik **Antigravity** sağlayıcısı (`antigravity`) ile birlikte çalışabilir. Antigravity Pro, resmi ACP 1.5.2 çekirdeği üzerinde çalışır (yönetilen Linux x86_64 çalışma zamanında uyumluluk yamalarıyla); yerleşik sağlayıcı ise ana makinede `agy`'yi çalıştırır.

![Paseo'da yan yana Antigravity Pro ve yerleşik Antigravity](./docs/images/antigravity-and-antigravity-pro.png)

Kimlik doğrulama, modeller, araçlar, yeniden denemeler ve konuşma geçmişi Google'ın çekirdeği tarafından yönetilir. Adaptör, Paseo'nun çalışma dizinini, arka plan talimatlarını ve becerilerini çekirdeğe iletir; yanıtları, izin isteklerini ve hataları Paseo'ya geri aktarır. Bu bir topluluk projesidir; Google çekirdeği ayrı olarak indirilir.

<!-- readme:value -->
## Neden paseo-agy-acp kullanmalı?

Adaptör, resmi 1.5.2 modlarını, yeniden denemelerini ve iptallerini kullanır. Çekirdeğin halihazırda sağladığı kural dosyaları, yol politikası, kurumsal kota görünümü ve lisans konumları çekirdekte kalır. Yönetilen Linux x86_64 uyumluluk katmanı desteklenen hesap modellerini geri yüklemeye, araçlar aracılığıyla becerileri sunmaya ve çekirdek olaylarını gözlemlemeye devam eder. Bu paketi yükleyin ve Paseo'yu yapılandırın; bağlantı gerçek istemci kimliğini korur.

Yeni mimarinin sundukları:

- Yüklü `agy` CLI'dan bağımsız olarak doğrudan bağımsız resmi ACP çekirdeğine bağlanır.
- Yönetilen Linux x86_64 çalışma zamanı, tur devam ederken çekirdek tarafından zamanlanan bir yeniden denemeyi veya gözlemlenen bir HTTP 503 durumunu gösterebilir.
- `max_tokens`, `max_turn_requests` ve `refusal` durumları başarılı gibi görünmek yerine hata olarak bildirilir.
- Somut model seçenekleri kullanılabilir kalır; yönetilen uyumluluk katmanı, çalışma alanına otomatik olarak beceri dosyaları yazmadan yerleşik becerileri araçlar aracılığıyla sunar.

### Yetenek karşılaştırması

#### Karşılaştırma temeli

- **Yerleşik Antigravity:** [Paseo `0.18.1`](https://github.com/getpaseo/paseo/releases/tag/v0.18.1) + `agy acp` olarak başlatılan [Google Antigravity CLI (`agy`) `1.5.18`](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.18).
- **Antigravity Pro:** aynı Paseo `0.18.1` + [`paseo-agy-acp` `2.11.1`](https://github.com/tiezbro/paseo-agy-acp/releases/tag/v2.11.1) ve `2.11.1` eşlik eden eklentisi + Google'ın bağımsız ACP çekirdeği `1.5.2` (`agy_acp_server`).

`agy` ve `agy_acp_server`, bağımsız sürüm numaralarına sahip ayrı Google dağıtımlarıdır. Linux x86_64 yönetilen uyumluluk özellikleri ayrıca belirtilmiştir. Karşılaştırma yayımlanan koda, belgelere ve bağlantılı kontrollere dayanmaktadır; aynı hesap üzerinde tam bir canlı karşılaştırma değildir.

| Yetenek | Paseo yerleşik Antigravity | Antigravity Pro (paseo-agy-acp) |
| --- | --- | --- |
| Başlatma ve kurulum | Sağlayıcı Paseo ile birlikte gelir ve ayrı olarak yüklenen resmi `agy acp` komutunu başlatır; Paseo 0.18.1, CLI 1.5.1 veya üzerini gerektirir. | Paseo adaptörü başlatır, adaptör de bağımsız `agy_acp_server` sürecini başlatır. Adaptör `--doctor`, yönetilen hazırlama ve açık çekirdek yolu destekler. Adaptör, eklenti ve çekirdek ayrı yaşam döngülerine sahiptir. |
| Google oturum açma ve depolama | CLI'nın oturum açma bilgisini kullanır; SSH ve SSH dışı çalıştırmalar farklı kimlik bilgilerini okuyabilir. | `--login`, bağımsız çekirdek için kişisel OAuth oturum açmayı yönetir. Genellikle `~/.gemini/antigravity-acp` altında ayrı bir kimlik bilgisi ve oturum deposuna sahiptir. |
| Gözetimsiz kimlik doğrulama | Paseo, gözetimsiz veya zamanlanmış çalıştırmalar için API anahtarı veya Agent Platform kimlik doğrulamasını belgeler. | Birlikte gelen `--login` yalnızca kişisel OAuth'u destekler. Eşdeğer bir API anahtarı veya Agent Platform kurulumu burada doğrulanmamıştır. İzin ayarları Google'ın hesap kurallarını değiştirmez. |
| Model kataloğu | Oturum açmış hesap için `agy`'nin ACP üzerinden duyurduğu modelleri kullanır. | Bağımsız çekirdeğin kataloğunu kullanır. Yönetilen Linux x86_64 üzerinde uyumluluk katmanı, hesabın sunduğu desteklenen Claude/GPT girdilerini geri yükler ve yukarı akış devre dışı model kontrollerini korur. İki katalog aynı hesap üzerinde karşılaştırılmamıştır. |
| Model önbelleği ve yenileme | 0.18.1 sürümünde Paseo, kataloğu yeniden başlatmalar arasında önbelleğe alır ve arka planda yoklama yapmak yerine isteğe bağlı olarak yeniler. | Birlikte gelen eklenti 0.18.1 üzerinde aynı isteğe bağlı ACP SDK katalog politikasını kullanır. |
| Düşünme düzeyleri | Her modelin kendi duyurduğu düzeyleri keşfeder; varsayılan modelin düzeylerini her modele uygulamaz. | Sunulduğunda Extra High dahil yerel düzeyleri iletir. Birlikte gelen eklenti, yerleşik sağlayıcının model başına katalog yoklamasına dahil olmaz. |
| Gruplanmış model görünümü ve sabit efor | SDK'nın model ve düşünme denetimlerini kullanır. Duyurulmuş düşünme düzeyi olmayan bir modelin seçici sunması gerekmez. | İletim hattında gruplanmış `configOptions` yapısını korur, ancak 0.18.1 eklenti SDK'sı seçim seçeneklerini düzleştirir. Sabit efor görüntüleme ara katmanı `Paseo` adını kontrol eder; 0.18.1 eklenti ana bilgisayarı `paseo` gönderdiğinden bu yolda ara katman etkinleşmez. Yerel eforu hiçbir zaman değiştirmez. |
| İzin modları | Default, Accept edits ve Plan dahil CLI modlarını ve uygun isteklerde "Bir kez izin ver" seçeneğini otomatik seçebilen Paseo'nun varsayılan Full access modunu sunar. CLI politikası geçerli olmaya devam eder. | Çekirdek Default, Auto Edit ve YOLO modlarını sağlar. YOLO bir çekirdek modudur; `/plan` bir komuttur. Hiçbiri yerleşik sağlayıcının Full access modu değildir. |
| Soruların onaylanması ve iptali | Araç onaylarını Paseo'ya iletir. Bir turu durdurmak bekleyen onayları temizler. | Çekirdeğin izin seçeneklerini iletir. 1.5.2 çekirdeği yanıtlanmamış isteklerin iptalini işler; YOLO tek başına istemciye ulaşan bir seçimi yanıtlamaz. Yerel soru formu eşdeğerliği doğrulanmamıştır. |
| Çalışma alanı güveni ve kancalar | Genel bir ACP izin arayüzüne sahiptir; çalışma alanı güveni ve kanca akışları ayrı olarak doğrulanmamıştır. | Çekirdek güven istemleri normal izin kanalı üzerinden iletilebilir. Paseo 0.18.1'deki eşdeğer sunum ayrı olarak doğrulanmamıştır. |
| Oturum listesi ve içe aktarma | Kaydedilmiş CLI konuşmalarını listeler ve içe aktarır; yukarı akış geçişi gerçek CLI kullanarak içe aktarmayı test etmiştir. | `session/list`'i iletir; çekirdek duyurduğunda eklenti SDK'sı listeleyebilir ve içe aktarabilir. CLI ve bağımsız geçmişler ayrıdır; sağlayıcılar arası içe aktarma doğrulanmamıştır. |
| Soğuk yeniden açma ve geçmiş | Kaydedilmiş oturumları `session/load` ile yükler; eski sağlayıcıdan kalan konuşma kimlikleri için uyumluluk ve geç yeniden oynatma olayları için 200 ms'lik bir sessizlik penceresi içerir. | Eklenti SDK'sı, yerleşik sağlayıcının ek yeniden oynatma penceresi olmadan `session/load` kullanır. Adaptör bir istemcinin devam ettirme isteğini iletebilir, ancak bu SDK'da ayrı bir geri yükleme yolu değildir. |
| Durdurma ve kurtarma | CLI yanıtından sonra çalışmaya devam eden araçlar için özel işleme ile ACP iptali gönderir. | ACP iptali gönderir, yerel olarak iptal edilen bir `end_turn` sonucunu `cancelled` olarak normalleştirir ve halihazırda gönderilmiş bir istem iptali onaylamazsa varsayılan olarak 30 saniye sonra bağlantıyı kapatır. |
| Takipler ve eşzamanlılık | Çalışan araçlar ve yinelenen zamanlamalarla ertelenen turlar etrafında özel bir takip yoluna sahiptir. | Adaptör tek bir oturum içindeki çakışan istemleri reddeder ve oturumlar arasında genel bir kuyruk uygulamaz. Eklenti, yerleşik sağlayıcının ertelenmiş tur işlemesine dahil olmaz. |
| Çalışma dizini ve ek kökler | SDK `cwd` gönderir; standart oturum isteği `additionalDirectories` göndermez. | Çalışma dizini sağlanmadığında `PASEO_AGENT_CWD` değerine geri döner. ACP üzerinden alınan `additionalDirectories` değerlerini iletebilir; birlikte gelen eklenti yine aynı SDK'yı kullanır. |
| Arka plan talimatları | CLI bu yeteneği duyurduğunda yerel oturum açılış eklemesi kullanır. | Varsayılan olarak daemon notunu her istemin başına ekler. `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` ve çekirdek desteği ile bunun yerine oturum açılışında ekler. |
| Eğik çizgi komutları ve beceriler | CLI tarafından duyurulan komutları ve becerileri gösterir, bunları menü için sınıflandırır ve ilk listeyi bekler. | Çekirdek tarafından duyurulan komutları korur ve yapılandırılmış Paseo, Agents, Codex, Claude ve Gemini kökleri dahil keşfedilebilir yerel becerileri ekler. Çakışmada çekirdek adları kazanır. Becerileri listelemek ve okumak için oturum araçları sağlar; yönetilen Linux x86_64 ayrıca çalışma alanına dosyalarını otomatik yazmadan yerleşik becerileri araçlar aracılığıyla sunar. |
| Görseller ve diğer ekler | SDK görselleri ACP görsel blokları olarak gönderir. Diğer girdi blok türleri bu SDK tarafından metne dönüştürülür. | Aynı Paseo SDK sınırı. Doğrudan bir ACP istemcisi adaptörün iletmesi için yerel kaynak blokları gönderebilir; yüklenmiş bir dosya Paseo'da yerel PDF veya ses desteğinin kanıtı değildir. |
| MCP | Ajanın yapılandırılmış MCP sunucularını `agy`'ye geçirir; yukarı akış gerçek bir stdio aracını ve onayını test etmiştir. | Yapılandırılmış MCP sunucularını kabul eder, stdio'yu korur, başlıkları normalleştirir ve HTTP/SSE URL'lerini yerel bir protokol köprüsü üzerinden yönlendirir. Uzak sunucu eşdeğerliği doğrulanmamıştır. |
| Akış ve araç kartları | Yanıtları ve bildirilen düşünceleri ayırır; kabuk çıktısı, çıkış kodları, dosyalar, arama ve MCP için CLI'ya özgü eşlemelere sahiptir. | Yanıtları, bildirilen düşünceleri ve araç olaylarını iletir. Birlikte gelen eklenti, yerleşik sağlayıcının CLI'ya özgü eşlemeleri yerine genel ACP araç kartlarını kullanır. |
| Bağlam ve token sayıları | Paylaşılan SDK, sağlandığında bildirilen token sayılarını ve bağlam penceresi kullanımını okur. | Aynı SDK çekirdeğin kullanım alanlarını tüketir. Bunlar kalan hesap kotasından ayrı olarak oturum başına metriklerdir. |
| Paseo Kullanım kota kartı | Paseo 0.17.6'da kaldırıldı; 0.18.1 temelinde bulunmaz. | 2.11.1'de birlikte gelen eklentiden kaldırıldı. Yalnızca CLI'yı yükseltmek, önceden yüklenmiş bir 2.11.0 eklentisinin arka plan kaynağını kaldırmaz. |
| Manuel hesap komutları | Resmi `agy` terminali kendi `/usage` ve oturum açma denetimlerine sahiptir. ACP menüsü yalnızca `agy` tarafından duyurulan komutları gösterir. | Bağımsız çekirdeğin `/usage` ve `/logout` komutları kaldırılan karttan ayrıdır; başa eklenen bir daemon notu bunların tek başına komut olarak tanınmasını engelleyebilir. Adaptörün `--usage` komutu uyumluluk için tutulmaktadır; bireysel OAuth kullanıcıları Google'ın resmi kota arayüzünü kullanmalıdır. |
| Tamamlanmamış tur nedenleri | Paylaşılan SDK'nın olağan istem yolunda, `max_tokens`, `max_turn_requests` veya `refusal` içeren başarılı bir yanıt tamamlandı olarak; bir ACP hatası başarısız olarak işaretlenir. | Bu nedenleri ACP hatalarına dönüştürür ve özgün değeri `error.data.stopReason` içinde korur. |
| Boş tamamlanma | Yerleşik sağlayıcıda veya olağan istem yolunda eşdeğer bir boş başarı denetimi bulunmamıştır. | Görünür bir yanıt veya araç etkinliği gözlemlenmediğinde başarılı bir bitişi reddeder. |
| Yeniden denemeler, HTTP 503 ve sonlandırma hataları | `agy`'nin ACP üzerinden gönderdiği durumları ve hataları kullanır; eşdeğer bir çekirdek olay gözlemcisi yapılandırılmamıştır. | Yönetilen Linux x86_64, turu sonlandırmadan çekirdek tarafından zamanlanan bir yeniden denemeyi veya 503 gibi gözlemlenen bir HTTP hatasını gösterebilir. Tek başına bir HTTP hatası yeniden deneme değildir. Gözlemci ayrıca `end_turn` olarak bildirilen bazı hataları düzeltebilir. |
| Sistem zarfları ve karusel metni | Yerleşik adaptörde eşdeğer bir zarf veya karusel dönüştürmesi bulunmamıştır. | `SYSTEM_MESSAGE` zarflarını ve karusel biçimlendirmesini okunabilir ACP metnine dönüştürür. Birlikte gelen eklentinin Paseo yolunda özel bir sistem kartı doğrulanmamıştır. |
| Kurallar ve yol politikası | Sağlayıcı Google kural veya yol politikasını kendisi uygulamaz; `GEMINI.md`, `AGENTS.md`, `.aiexclude` ve yönetici kuralları için eşdeğer davranış doğrulanmamıştır. | Bağımsız 1.5.2 çekirdeği kural keşfine ve yol zorlamasına sahiptir; adaptör ortaya çıkan araç hatalarını iletir. |
| Kurumsal politika ve lisans konumları | Sağlayıcı belgeleri Agent Platform kimlik doğrulamasını açıklar; lisans bölgesi geri dönüşü ve tam kurumsal politika davranışı doğrulanmamıştır. | Bağımsız çekirdek kullanılabilir olduğunda kurumsal politikaya ve lisans konumlarına sahiptir; birlikte gelen oturum açma komutu hala yalnızca kişisel OAuth destekler. |

Kaynaklar: [Paseo sağlayıcı belgeleri](https://github.com/getpaseo/paseo/blob/v0.18.1/public-docs/supported-providers/antigravity.md), [yerleşik ACP geçişi ve canlı kontroller](https://github.com/getpaseo/paseo/pull/10193), [Paseo ACP SDK](https://github.com/getpaseo/paseo/blob/v0.18.1/packages/plugin/src/server/acp-internal/connection.ts), [Paseo eklenti istemci kimliği](https://github.com/getpaseo/paseo/blob/v0.18.1/packages/server/src/server/agent/plugin-provider.ts#L94-L104), [Pro eklenti kaydı](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/plugins/paseo-agy-acp/index.server.ts), [Pro sabit efor uygulaması](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/fixed-model-effort.ts), [Pro ACP aktarımı ve tur sonuçları](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/proxy.ts) ve [kota kaldırma ve yükseltme notları](docs/operations/paseo-quota.md). [Resmi 1.5.0 yetenek kataloğu](docs/research/2026-11-19-official-capability-catalog.md), eski bağımsız çekirdek için tarihsel kanıttır.

<!-- readme:architecture -->
## Mimari

```text
Paseo → ACP / NDJSON → paseo-agy-acp → agy_acp_server 1.5.2 → Google
```

Her adaptör süreci bir çekirdek alt süreci başlatır. Yönetilen kurulum Google'ın özgün indirmesini doğrular ve Linux x86_64 üzerinde ayrı bir uyumluluk çalışma zamanında bir çekirdek olay gözlemcisi ekler. Doğrudan değiştirilmemiş resmi bir yürütülebilir dosyaya da bağlanabilirsiniz; bu durumda yeniden deneme, HTTP ve sonlandırma hatası bildirimleri söz konusu yürütülebilir dosyanın sağladığı sinyallere bağlıdır.

Oturum geçmişi çekirdek tarafından saklanır; adaptörün zamanlama veritabanı veya çalışma zamanı npm bağımlılıkları yoktur. Bir bağlantıdaki yeni oturumlar, erken komut menülerinin doğru çalışma alanına bağlanması için sırayla açılırken farklı oturumlardaki istemler eşzamanlı olarak çalışır.

<!-- readme:requirements -->
## Gereksinimler

- Node.js 22 veya üzeri ve özel ACP sağlayıcı desteğine sahip Paseo.
- Resmi Antigravity hizmeti için yetkilendirilmiş bir Google hesabı.
- Yönetilen Linux x86_64 sarmalayıcısını çalıştırmak için root olmayan bir kullanıcı.

<!-- readme:quickstart -->
## Deneyin

Yayımlanan paketi Paseo daemon'ını çalıştıran ana makineye yükleyin. Aynı tarball'ı kaynaktan derlemek için önce eşleşen sürüm etiketini kontrol edin, ardından Geliştirme bölümünü izleyin.

```bash
npm install --global ./paseo-agy-acp-2.11.1.tgz
paseo-agy-acp --doctor
paseo-agy-acp --prepare-kernel
paseo-agy-acp --login
```

`--doctor` yerel kurulumu kontrol eder, `--prepare-kernel` gerektiğinde sabitlenmiş çekirdeği indirir ve `--login` kişisel Google OAuth ile oturum açar. Başsız (headless) bir ana makinede başka bir cihazdaki tarayıcıda yetkilendirme yapın ve localhost geri çağırma URL'sini daemon ana makinesindeki oturum açma terminaline geri yapıştırın.

Aşağıdaki örneği `~/.paseo/config.json` içindeki `agents.providers` bölümüne birleştirin. Daemon yürütülebilir dosyayı `PATH` üzerinde bulamazsa `command` içinde mutlak yolunu kullanın.

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "enabled": true,
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["paseo-agy-acp"]
      }
    }
  }
}
```

Değişiklikler yeni başlatılan ajanlar için geçerlidir. Paseo'da oturum oluştururken **Antigravity Pro**'yu seçin.

### İsteğe bağlı Paseo eklentisiyle sağlayıcıyı kaydetme

Paseo 0.17.4 veya sonraki sürümlerde eşlik eden eklenti `paseo-agy-acp` sağlayıcısını kaydedebilir.

1. Paseo daemon ana makinesinde adaptörü yükleyin ve gerekirse çekirdeği hazırlayın. Mevcut ACP oturum açmanızı yeniden kullanın veya yeni bir hesap için `paseo-agy-acp --login` çalıştırın.

   ```bash
   npm install --global paseo-agy-acp@2.11.1
   paseo-agy-acp --prepare-kernel
   ```

2. Eşlik eden eklentinin sağlayıcıyı kaydetmesini istiyorsanız, hedef daemon için **Settings → Plugins** altında **Enable plugins** seçeneğini açın, ardından eklentiyi aynı npm sürümünden yükleyin.

   ```bash
   paseo plugin install npm:paseo-agy-acp@2.11.1:plugins/paseo-agy-acp
   ```

3. `~/.paseo/config.json` içinde zaten bir `agents.providers["paseo-agy-acp"]` girdiniz varsa, eklentinin sağlayıcıyı kaydetmesi için `extends` ve `kind` alanlarını kaldırın. Mevcut `command`, `env` ve diğer geçersiz kılmaları koruyun. Eklentinin sağlayıcı ayarlarını geçersiz kılmak için minimal bir örnek aşağıdadır. Daemon'ınız `PATH` üzerinde `paseo-agy-acp`'yi bulamıyorsa `command` değerini yüklü yürütülebilir dosyanın mutlak yoluna ayarlayın.

   ```json
   {
     "agents": {
       "providers": {
         "paseo-agy-acp": {
           "enabled": true,
           "label": "Antigravity Pro",
           "command": ["paseo-agy-acp"]
         }
       }
     }
   }
   ```

   Daemon adaptörü `PATH` üzerinde bulabiliyorsa ve herhangi bir geçersiz kılmanız yoksa eklentinin varsayılanları yeterlidir.

4. Yapılandırmayı yeniden yükleyin ve eklentinin `running` durumda olduğunu kontrol edin.

   ```bash
   paseo reload --json
   paseo plugin ls paseo-agy-acp --json
   ```

Adaptörü ve eklentiyi birlikte yükseltin.

<!-- readme:configuration -->
## Yapılandırma

| Ortam değişkeni | Amaç |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Mevcut bir çekirdek veya sarmalayıcı için mutlak yol. Yönetilen kurulum için boş bırakın. |
| `PASEO_HOME` | Paseo daemon veri dizini (varsayılan: `~/.paseo`). |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | Çekirdek tarafından duyurulduğunda oturum düzeyinde arka plan talimatlarını kullanmak için `1` olarak ayarlayın. |
| `AGY_ACP_DIAGNOSTICS` | Aşama zamanlamalarını stderr'e günlüklemek için `1` olarak ayarlayın (istem metnini ve kimlik bilgilerini içermez). |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | Milisaniye cinsinden iptal onayı zaman aşımı; pozitif tam sayı (varsayılan: `30000`). |

Desteklenen mod kimlikleri `default`, `auto_edit` ve `yolo` şeklindedir. Mevcut yapılandırmalar hala `accept-edits` (`auto_edit`) veya `dangerously-skip-permissions` (`yolo`) kullanabilir; bilinmeyen modlar ise çekirdek tarafından doğrulanır. Bir plan istemek için sohbette `/plan` kullanın.

İzin istekleri yanıtlanana veya iptal edilene kadar açık kalır. Bir ağ proxy'si kullanırken ortam değişkenlerini sağlayıcı üzerinde yapılandırın ve yerel MCP uç noktalarını `NO_PROXY` içine ekleyin.

Beceri keşfi yapılandırılmış dizinleri, çalışma alanı köklerini, genel Gemini/Agents/Codex köklerini ve Paseo uyumluluk dizinlerini tarar; çalışma alanı becerileri aynı addaki genel becerileri geçersiz kılar. `user-invocable: false` ayarlamak bir beceriyi eğik çizgi menüsünden gizler. Oturumun salt okunur `paseo_skills` MCP sunucusu yalnızca keşfedilen beceri dizinlerini dosya başına en fazla 1 MiB boyutunda okur.

<!-- readme:operations -->
## İşlemler ve doğrulama

Genel kuyruklamaya sahip bir sürümden geçiş yaparken `AGY_ACP_ADMISSION_*` ve `AGY_ACP_STATE_DIR` değişkenlerini kaldırın. Mevcut defter dosyaları diskte okunmadan kalır ve `agy-acp-prepare-state` komutu kaldırılmıştır. Hesap kotası, yukarı akış 429/502/503 yanıtları ve üretim gecikmesi yukarı akış hizmetinin kontrolü altında kalır.

2.9.2'den 2.10.0'a yükseltme yapmak, yönetilen 1.5.0 çekirdeğini 1.5.2 ile değiştirir; 1.5.0 uyumluluk makbuzları yeniden kullanılamaz. Yükseltme veya yeniden derleme sonrasında, sağlayıcı tanılamalarını çalıştırmadan önce terminalde `paseo-agy-acp --prepare-kernel` çalıştırın ve tamamlanmasını bekleyin (kaynak kodundan kontrol için `node "dist/ACP Connector/main.js" --prepare-kernel` çalıştırın). İlk hazırlık birkaç dakika sürebilir ve Paseo'nun 20 saniyelik tanılama başlatma zaman aşımını aşabilir. Halihazırda çalışan oturumlar yüklü çekirdeklerini kullanmaya devam eder.

Adaptör gruplanmış `configOptions` gönderir ve eski düz `models` kataloğunu atlar. Bu, ACP yanıtını tanımlar; Paseo 0.18.1'in eklenti SDK'sı seçimleri düzleştirir. Hesap tarafından sunulduğunda Gemini ve Claude 5.5 dahil yerel katmanlara sahip modeller, çekirdek tarafından bildirilen düzeyleri kullanır. Gemini 4 Neon ve Hydrogen'in Extra High düzeyi değiştirmeden iletilir. Sabit efor ara katmanı daha eski bir istemci yoluyla test edilmiştir; 0.18.1 eklentisiyle davranışı için yukarıdaki karşılaştırmaya bakın. Yönetilen Linux x86_64 ayrıca istemci kimliğini değiştirmeden yukarı akış hesap kataloğundan desteklenen üçüncü taraf girdilerini geri yükler. Önbelleğe alınmış çekirdekler yalnızca hem uyumluluk modülü hem de yama tarifi eşleştiğinde yeniden kullanılır. Model kullanılabilirliği yine yukarı akış hesap kataloğunu izler.

- [Eski kuyruktan geçiş yapın](docs/operations/admission.md)
- [Hafif adaptörü doğrulayın](docs/operations/lightweight-adapter.md)
- [Çekirdek sarmalayıcısını çalıştırın](docs/operations/official-kernel-compat-runbook.md)
- [Bir Paseo istemcisiyle doğrulayın](docs/operations/paseo-adapter-verification.md)
- [Canlı bir hesapla gruplanmış modelleri doğrulayın](docs/operations/2026-11-22-grouped-model-acceptance.md)
- [Ana makineler arasında doğrulayın](docs/operations/paseo-cross-host-e2e.md)
- [npm'e yayınlayın](docs/operations/npm-publishing.md)
- [Eşlik eden eklentiyi yayınlayın, yükleyin ve güncelleyin](docs/operations/plugin-releases.md)

2.11.1 sürümü Paseo **Usage** içinden Antigravity ACP kartını kaldırdı. 2.11.0 eklentisini yüklediyseniz, eski kullanım kaynağını kaldırmak için eklentiyi adaptörle birlikte güncelleyin. [Yükseltme kılavuzu](docs/operations/paseo-quota.md#已安装-2110-用户的升级步骤)

<!-- readme:development -->
## Geliştirme

Kaynak kökünden geliştirme bağımlılıklarını yükleyin, adaptörü derleyin ve hızlı başlangıçta kullanılan npm tarball'ını paketleyin:

```bash
npm ci
npm run build
npm pack
```

```bash
npm run validate
npm run test:paseo-provider
npm run test:paseo-client
```

İstemci testleri, doğrulama kılavuzundaki kilitli Paseo fikstürlerine ve simüle edilmiş bir çekirdeğe karşı çalışır. Gerçek bir hesap kullanarak resmi çekirdeği ve adaptörü karşılaştırmak için bağımsız yoklamayı çalıştırın:

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

Her iki grup da aynı modeli kullanır ve etkin hesaptan kota tüketir. Yoklama araç izinlerini reddeder, beklenmedik sonuçlarda durur ve süreçlerini temizler. Raporlar yalnızca zamanlamaları ve durumu kaydeder; model çıktısını ve ham hataları içermez. Tarihsel kanıtlar `docs/research/` ve `docs/design/` içindedir.

<!-- readme:license -->
## Lisans

[Apache-2.0](./LICENSE)
