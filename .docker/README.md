# Запуск

Все настройки хранятся в `.env`. Для новой установки скопируйте `.env.example`
в `.env`, задайте пароль RPC и поместите данные ATCOIN с кошельком в
`.docker/node/atcoin`. Текущий кошелёк — `M891861`.

```sh
make up       # конфигурация, сборка, запуск трёх сервисов
make check    # веб-портал, владение адресом, авторизация и задание Stratum
make logs
make ps
make restart  # применить изменения .env, пересоздать контейнеры
make stop
make down     # данные Redis и ATCOIN сохраняются
```

Docker запускается через `sudo docker`. Для пользователя с доступом к Docker:
`make DOCKER=docker up`. Node.js на хосте не требуется: генератор настроек
и сборка зависимостей используют Node.js 22 в Docker.

Контейнеры: `atcoin-portal`, `atcoin-portal-redis`, `atcoin-portal-node`.
По умолчанию сайт: http://localhost, Stratum: `127.0.0.1:3333`.
Логин майнера — адрес кошелька без суффикса `.worker`, пароль — `x`.
RPC не публикуется на хост; Redis публикуется только на loopback.
Контейнеры используют bridge-подсеть `172.30.64.0/24`; генератор RPC разрешает
её по умолчанию. При изменении подсети задайте согласованный `ATCOIN_RPC_ALLOW_IP`.
Портал работает от пользователя `node`. Redis использует AOF с `appendfsync always`.

Основные переменные: `ATCOIN_RPC_*`, `ATCOIN_WALLET`, `ATCOIN_POOL_ADDRESS`,
`ATCOIN_P2P_PORT`, `WEBSITE_PORT`, `REDIS_PORT`, `STRATUM_PORT`,
`STRATUM_DIFFICULTY`, `STRATUM_VARDIFF`, `POOL_FEE_PERCENT`.
Остальные параметры старых конфигураций перенесены без потерь в переменные
`PORTAL__…`, `POOL__…`, `COIN__…`: двойное подчёркивание обозначает вложенность,
значение имеет JSON-формат внутри одинарных кавычек dotenv.
Например, `POOL__paymentProcessing__enabled='true'` и
`POOL__paymentProcessing__minimumPayment='70'`.

`scripts/setup-config.js` генерирует JSON-конфигурации внутри контейнера.
`make rpc-config` генерирует `.docker/generated/atcoin.conf` для RPC-узла.
Не редактируйте сгенерированные файлы: изменяйте `.env` и выполняйте `make restart`.
Старые `config.json` и `pool_configs/*.json` на хосте Docker не использует.
`.env`, сгенерированные файлы и данные узла исключены из Git и контекста сборки.

Dockerfile портала: `.docker/npm/Dockerfile`, контекст — корень проекта,
рабочая директория — `/app`. Установлены Node.js 22, npm, Python 3, make,
GCC/G++. Нативные модули собираются из исходников при сборке образа;
`node_modules` хоста не используется. При смене Node.js выполните `make up`.
Патчи старой библиотеки добавляют RPC-путь кошелька и Bech32/Bech32m;
для `multi-hashing` используется C++17.

`make check` не отправляет транзакции и не выполняет майнинг.
Реальные выплаты делает обработчик пула по накопленным в Redis начислениям.

## Проверки безопасности

`npm test` запускает изолированные регрессионные тесты на Node 22.
`npm run check` и `make check` обращаются к настроенному RPC и Stratum;
это отдельная эксплуатационная проверка.

Админ-панель требует пароль от 16 символов и HTTPS. Cookie сессии имеет
HttpOnly, Secure, SameSite=Strict; исходный пароль больше не сохраняется.
За TLS reverse proxy укажите `website.adminCenter.origin` — точный публичный
origin (например `https://pool.example`). Для локального HTTP разрешено явно
задать `secureCookies: false`; production должен использовать Secure.

Журналы `paymentInFlight`, `paymentCommitPending` и `paymentCycleLock` нельзя
удалять для принудительного перезапуска выплат без сверки с кошельком.
Процедура и ограничения приведены в `SECURITY_AUDIT.md` в корне репозитория.
