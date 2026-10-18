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
RPC и Redis публикуются только на loopback хоста. Для сети узла Docker сам
выбирает свободную подсеть. Портал использует сеть хоста Linux.

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
