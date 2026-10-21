# Аудит безопасности node-open-mining-portal

Дата: 2026-10-22. Объект: текущий распакованный репозиторий, включая Dockerfile,
lockfile, установленную зафиксированную зависимость stratum-pool и статические JS.
Production-конфигурации и `.env` не изменялись. Реальные RPC, Stratum, Redis/MySQL
сервисы не проверялись и реальные переводы не выполнялись.

## Модель угроз

| Актив | Граница доверия и возможное воздействие | Защита / остаточное ограничение |
|---|---|---|
| Средства кошелька | Процесс выплат → аутентифицированный wallet RPC; неизвестный результат sendmany может вызвать повторную отправку | Предварительный journal, межпроцессная блокировка, сверка txid/comment/outputs; неопределённость останавливает выплаты |
| RPC credentials | Конфигурация → процессы приложения, Docker env, HTTP Basic внутри bridge | Админский API возвращает только разрешённые метаданные; RPC не опубликован на хост; приватную сеть необходимо считать доверенной |
| История выплат | Redis balances/payouts/paymentHistory ↔ wallet transaction | План учёта сохраняется до EXEC; проверяются ошибки отдельных команд; частичный результат требует ручной сверки |
| Балансы майнеров | Redis → расчёт суммы → sendmany | Строгие десятичные суммы, безопасный диапазон, BigInt для распределения, validateaddress перед переводом |
| Shares и блоки | Недоверенные Stratum-сообщения → job validation → shareProcessor → Redis | Ограничения и дедупликация в зафиксированной Stratum-зависимости; проверены положительные и отрицательные сценарии; повреждённые shares не оплачиваются |
| Админские права | Браузер → HTTP API | Случайные серверные сессии, HttpOnly/Secure/SameSite, срок 30 минут, custom header + Origin, ограничение попыток |
| Доступность Stratum | Интернет → TCP/JSON → RPC/native hashing | Лимиты сообщений, handshake/auth deadlines, admission budgets и ban windows присутствуют в зависимости; локальные regression tests прошли |
| Redis/MySQL/CLI | Внутренняя сеть и loopback → привилегированные операции | Redis loopback publication; CLI loopback, bounded framing; SQL placeholders; Redis и локальные пользователи остаются доверенной границей |
| Секреты инфраструктуры | `.env`, generated files, image context, логи | Файлы генератора chmod 0600, Docker exclusions, пароль майнера исключён из логов, dumpprivkey удалён из веб-процесса |

Публичны адреса/имена воркеров, shares, балансы, агрегаты и txid выплат. Это модель
публичного пула; RPC credentials, исходные конфигурации и приватные ключи публичными
данными не являются. Полный контроль над Redis позволяет подменить корректно
сформированные балансы; валидация значений не превращает Redis в недоверенный ledger.
Компрометация процесса выплат или wallet RPC остаётся критической для средств.

## Подтверждённые проблемы и исправления

| Приоритет | Доказанный путь / CWE | Исправление и проверка |
|---|---|---|
| Critical | Два процесса могли рассчитывать/фиксировать один ledger независимо; локальный `processing` защищал только один процесс (CWE-362) | Невытесняемая Redis NX-блокировка на весь цикл. Тест с прежним владельцем запрещает отправку; timer overlap и restart reconciliation проверены |
| Critical | Redis EXEC может вернуть ошибки внутри replies при отсутствии общей ошибки; журнал мог удалиться при частично применённом учёте (CWE-252, CWE-841) | Проверка каждого reply, сохранение `paymentCommitPending` до EXEC, блокировка сохраняется при неоднозначном учёте. Тесты общего сбоя, WRONGTYPE и отказа записи плана |
| High | Непроверенные Redis-балансы и shares, float-конверсия и небезопасные суммы (CWE-20, CWE-682) | Строгие decimals, BigInt деление долей, safe integers, обратная проверка представимости wallet JSON-RPC, validateaddress. Проверены отрицательные, NaN/Infinity, overflow, дробные доли и округление |
| High | Пароль администратора жил в JS-readable cookie и повторялся в каждом запросе; отсутствующее поле пароля могло совпасть с отсутствующим конфигом (CWE-287, CWE-315) | Только login принимает пароль, минимум 16 символов; API требует случайную серверную сессию. Реальные HTTP routes проверены без cookie, с body password, после login; expiry/tampering/bruteforce/CSRF проверены отдельно |
| High | После успешной парольной проверки `/api/admin/pools` возвращал полные poolConfigs, включая RPC/Redis credentials (CWE-200) | Allowlist `{coin: {name}}`. Регрессия проверяет результат с синтетическими RPC/Redis secrets. Анонимная утечка при корректном пароле конфигурации не заявляется |
| High | Исключение JSON.parse внутри async TCP callback не попадало во внешний try/catch, позволяя локальному клиенту уронить master (CWE-248, CWE-400) | Парсинг внутри callback, лимит 8 KiB, 5 секунд, 32 подключения, одна команда, schema/allowlist. Проверены broken/fragmented/oversized/multiple/unknown и normal commands |
| High | Пароль майнера записывался в debug log при авторизации (CWE-532) | Пароль удалён; workerName выводится через JSON.stringify, ограничены тип и длина |
| High | `dumpprivkey` вызывался веб-процессом ради version byte (избыточные привилегии) | Вызов удалён; legacy Base58 keygen использует явно заданный `coin.privateKeyVersion`, witness-адреса как и прежде не обслуживаются legacy генератором |
| Medium | difficulty включалась в SQL строкой (CWE-89) | finite positive number + placeholders. Тест проверяет bind malicious username и отказ строковой/отрицательной difficulty; удалённая достижимость SQL injection через normal Stratum не доказана |
| Medium | HTTP JSON/API/SSE допускали лишние типы, большие строки, накопление connections/buffers (CWE-400) | JSON 8 KiB, query strings до 256, rate 120/IP/min, SSE cap 256 и backpressure, server limits; HTTP headers и generic parse errors. Проверены типы, лимиты и disconnect |
| Medium | Raw admin pool names попадали в HTML-конкатенацию; inherited page properties принимались за страницы (CWE-79) | DOM `.text()`, Object.hasOwn. Miner charts уже использовал `{{!}}`; hostile identifier escaping проверен, исходная reflected XSS здесь не заявляется |
| Medium | Вспомогательный immature RPC мог безлимитно собирать body и несколько раз вызывать async callback | 2 MiB, абсолютные 10 секунд, once completion; тесты normal/malformed/oversized/aborted |
| Medium | Генератор конфигов принимал дробные/нулевые/слишком большие порты; mode 0600 не менял права существующего файла | Port/range/varDiff checks, chmod существующих файлов. Тесты missing params, port bounds, prototype keys, newline injection |
| Medium | Legacy keygen заменял нулевые CSPRNG bytes на Math.random и принимал нулевой/внепорядковый scalar | Сохранены равномерные CSPRNG bytes, scalar range/rejection sampling; проверены нулевой и максимальный scalar, сохранность нулевых случайных bytes |
| Supply chain | Wildcards и неприкреплённая Git-зависимость, request/bignum advisories, jquery 2.1.0 | Прямые версии зафиксированы, Git SHA из lockfile сохранён. Request заменён ограниченным native HTTP adapter, bignum — BigInt target conversion. Совместимые proxy-addr/trim-newlines overrides; статический jquery 3.7.1 с MIT license |

Распределение вознаграждения остаётся `floor(reward * workerShares / totalShares)`.
Теперь дробные shares преобразуются в целые веса, а деление выполняется BigInt:
это исправляет погрешность binary float на границах одного atomic unit, сохраняя
пропорции и прежнее поведение остаточной пыли. Порог выплаты, получатели комиссий,
адреса и параметры блокчейна не менялись.

## Выплаты: порядок и восстановление

1. `SET coin:paymentCycleLock token NX` до чтения балансов; блокировка не имеет TTL.
   Второй процесс не имеет права читать/фиксировать платёжный цикл параллельно.
2. Проверка отсутствия `paymentCommitPending`, чтение rounds/shares/balances,
   точный расчёт, проверка адресов в текущем кошельке/сети.
3. `paymentInFlight` с уникальным comment сохраняется до sendmany. Ошибка сохранения
   запрещает RPC. Общая wallet error не считается доказательством отсутствия tx.
4. При потерянном ответе журнал остаётся. Следующий завершившийся без аварии цикл
   сверяет listtransactions по comment и gettransaction по outputs, conflict и
   abandoned flags; sendmany повторно не вызывается. Нулевое/несколько совпадений,
   несовпадение outputs, невалидный journal или конфликт не разрешают новый перевод.
5. До EXEC сохраняется `paymentCommitPending`: receipt и точный список команд учёта.
   При EXEC failure/error reply сохраняется fence, выплаты останавливаются.
   Журнал коммита удаляется только после успешной проверки replies.
6. Lock освобождается после известного завершения цикла. Аварийное завершение
   владельца оставляет lock и намеренно требует сверки вместо автоматического lease expiry.

Оператору при остановке:

- Остановить все payment workers для данного coin и убедиться, что прежний процесс
  не продолжает работу. Сделать закрытые копии Redis ledger, трёх journal/lock keys,
  wallet history и локального файла recovery commands, если он создан.
- По comment найти все wallet tx. Проверить получателей, точные atomic amounts,
  конфликты, abandoned/confirmation state. Отсутствие записи в первой странице
  listtransactions не доказывает отсутствие перевода: автоматический поиск ограничен
  1000 записями и безопасно останавливается при отсутствии однозначного результата.
- При `paymentCommitPending` определить, какие команды реально применились:
  Redis MULTI/EXEC не откатывает остальные команды после WRONGTYPE. Не выполнять
  сохранённый список HINCRBYFLOAT повторно целиком — это может удвоить учёт.
- Только после согласования wallet, balances, rounds, payouts и history завершить
  учёт и снять соответствующие journals/lock. Удаление journal ради «починки» без
  сверки может привести к повторному переводу. Автоматическая команда удаления
  блокировок намеренно не предоставляется.

Сбой Redis durability/утрата volume или потеря записей при failover не решаются
приложенческой блокировкой. Compose использует AOF + appendfsync always; для внешнего
Redis нужны эквивалентные гарантии и backups. Владельцы Redis/кошелька доверенные.

## HTTP и конфигурация развёртывания

Админская сессия хранится только в памяти процесса, cookie содержит случайный token,
на сервере хранится его SHA-256 digest. Перезапуск веб-процесса завершает сессии.
Secure cookie включён по умолчанию; HTTPS обязателен. Для TLS reverse proxy следует
задать точный `website.adminCenter.origin`. Только для локального HTTP допускается
явный `secureCookies: false`. В многопроцессном веб-развёртывании нужны sticky sessions
или отдельное согласованное хранилище сессий; текущий init запускает один web worker.
Rate limiting по socket IP не доверяет подставленному X-Forwarded-For; за общим reverse
proxy лимит распространяется на его клиентов суммарно — учитывать на ingress.

RPC bind 0.0.0.0 сохранён внутри контейнера для связи portal → node. Broad allow
0.0.0.0/0 заменён на конкретную Docker bridge 172.30.64.0/24 и согласован с Compose
IPAM. При конфликте подсети с инфраструктурой требуется выбрать свободную и обновить
ATCOIN_RPC_ALLOW_IP. Существующие production node config не перезаписывались.
Redis опубликован только на loopback; соединения внутри bridge без пароля, доступ
к Docker network/host является доверенным. Portal container работает как `node`,
no-new-privileges, drop ALL с NET_BIND_SERVICE для совместимости с HTTP port 80.
Wallet container всё ещё root с существующим datadir mount: миграция владельца
production wallet требует отдельной проверки прав и backup.

Генератор приватных ключей — legacy браузерный инструмент с собственным старым ECC
кодом, не новый проверенный криптографический продукт. Изменения не являются
сертификацией всего ECC-кода. CSP ограничивает frames/objects/base, но допускает
существующие inline scripts. Полная CSP с nonce и browser E2E здесь не внедрены.

## Проверки и ограничения доказательств

На Node 22.22.1 собран native multi-hashing с теми же C++17/aliasing flags, что Docker.

- `PATH=/usr/bin:/bin npm test`: security node:test suite, payment RPC/Redis mocks,
  статистика/история и все шесть Stratum test suites через `scripts/test-stratum.js`.
  Итог: 15 собственных + 42 dependency node:test (57 всего), плюс платёжный и
  статистический сценарные скрипты. `npm test` больше не запускает live `scripts/check.js`.
- `node node_modules/stratum-pool/test/stratum.test.js`: 15 тестов framing, malformed
  auth, limits, budgets, bans, disconnect и нормального submit.
- `node node_modules/stratum-pool/test/jobs.test.js`: 8 тестов target/native hashing,
  duplicate shares, malformed submissions и обычной valid share.
- `node node_modules/stratum-pool/test/authorize.test.js`: 1 тест лимитов/cache/cancel.
- `node node_modules/stratum-pool/test/daemon.test.js`: 13 тестов RPC protocol,
  timeout, cancellation, aborted и oversized replies на loopback mock.
- `node node_modules/stratum-pool/test/pool.test.js`: 4 интеграционных теста локального
  пула с fake RPC: normal handshake, polling/retry/shutdown и block outcomes.
- `.docker/npm/check-native.js`: native Scrypt совпал с эталоном на 10 headers.
- `docker compose config --quiet`: успешно; полный стек не собирался и не запускался.
- `npm audit --json --ignore-scripts`: до изменений 9 затронутых пакетов (3 critical,
  3 high, 3 moderate), после обновления lockfile — 0 advisories. Это состояние
  доступной npm advisory database, а не доказательство отсутствия неизвестных проблем.
  Static d3/nvd3 и Git/native source не покрываются такой гарантией.
  Снимки результатов: `docs/npm-audit-before.json`, `docs/npm-audit-after.json`.

Не выполнены: реальные Redis/MySQL fault injection, mainnet/regtest wallet payments,
проверка восстановленного production backup, браузерный E2E, полная Docker image
сборка и проверка маршрутизации работающих контейнеров. Dockerfiles в репозитории
присутствуют, поэтому отсутствие файлов не является заявленной причиной пропуска.
ATCOIN binary image скачивает release deb без checksum/signature pin; это остаётся
supply-chain риском и требует независимо проверенного digest издателя. Не добавлен
выдуманный checksum. Обновление redis 0.12.1 до современного major не выполнялось:
его callback/MULTI API требует отдельной миграции и реальных Redis integration tests.
Текущий npm audit не сообщает advisory для этого пакета, но его возраст остаётся риском.

Комиссия sendmany оплачивается пулом, rewards не уменьшаются при ошибке fee estimation.
feeRate проверяется как finite positive; абсолютный размер fee и relay policy остаются
ограничениями кошелька (`maxtxfee` и политика узла), а не доказанной здесь гарантией.
Публичные API считают полные snapshots/worker collections: лимиты уменьшают DoS,
но нагрузочное capacity testing и внешняя DDoS-защита не заменяются unit tests.
