# Backend в Docker: локальный runbook

Docker используется для backend и изолированной PostgreSQL. Frontend продолжает работать на хосте. Это учебный стенд с fake Odoo; схема источника не подтверждает устройство реальной клиентской базы.

Документ обновлён 2026-11-04 по `compose.yaml`, Dockerfile и выполненным проверкам. Сборка runtime/tools, перенос существующих данных, Docker-тесты и работа host frontend через Docker API подтверждены; подробные результаты приведены ниже. Полный fresh-сценарий из отдельного раздела не выполнялся.

После последующего добавления Vehicles и поддержки нескольких sales orders стенд пересобран и перезапущен: в main/test пять миграций, backend/db healthy, importer успешно обрабатывает 20 pickings. Финальные container typecheck/typed lint и **111/111 backend tests** — PASS; frontend **73/73**, production build и read-only live smoke **1/1** — PASS. Последний backup/preservation report указан в [recovery.md](recovery.md); новая функциональность и живой учебный пример — в [vehicles.md](vehicles.md) и [STATUS.md](STATUS.md). Исторические результаты первичного Docker-переноса ниже относятся к своему этапу.

## Каталоги, адреса и данные

Все команды ниже выполняются в PowerShell 7 из каталога backend:

```powershell
cd C:/Users/MOHD/Desktop/backoffice/backoffice-backend
```

Требуются Docker Desktop с Linux containers, Docker Compose v2 и работающий Docker Engine. Нативные PostgreSQL 18 tools нужны только для копирования существующего стенда через его backup-скрипт.

| Компонент | Адрес / назначение |
| --- | --- |
| Compose project | `delivery-backoffice` |
| PostgreSQL внутри сети Compose | `db:55432` |
| PostgreSQL с хоста | `127.0.0.1:55433` |
| Backend с хоста | `http://127.0.0.1:3001/api` |
| Frontend на хосте | `http://127.0.0.1:3000` |
| Нативная PostgreSQL до переноса | `127.0.0.1:55432`, отдельный сохранённый кластер |

В браузере `NEXT_PUBLIC_API_URL` остаётся `http://127.0.0.1:3001/api`. Имя `db` предназначено только для контейнеров. Origin frontend остаётся точным `http://127.0.0.1:3000`; сессии и авторизация сохраняют существующие правила.

Named volume `pg-data` хранит PostgreSQL, `app-data` — `/app/.local`, включая приватные файлы и локальные demo accounts. При стандартном имени проекта фактические имена имеют префикс `delivery-backoffice_`. PostgreSQL 18 volume смонтирован в `/var/lib/postgresql`; данные находятся в version-specific `PGDATA` образа.

`./scripts/docker-configure.ps1` создаёт или проверяет семь файлов в игнорируемом `.local/docker/secrets`. Согласованные существующие файлы сохраняются. Пароли и connection URLs не включаются в образ или Compose YAML. Их содержимое не нужно печатать, копировать в отчёты или коммитить.

## Образы и сервисы

Dockerfile использует `node:26.13.0-bookworm-slim`. Runtime запускается от `node`, содержит собранный `dist` и зависимости `npm ci --omit=dev`; команда процесса — `node dist/main.js`. `.local` остаётся writable volume, остальные runtime-файлы read-only. Linux-зависимости, включая native sharp, устанавливаются внутри образа; Windows `node_modules` в него не копируется.

Стадия `tools` содержит dev dependencies, TypeScript source, scripts и tests. `NODE_ENV=development` в ней нужен существующим учебным import/demo runners; runtime имеет `NODE_ENV=production`. Сборку обновляют через Docker build, а не через компиляцию в запущенном runtime-контейнере.

| Сервис | Поведение |
| --- | --- |
| `db` | PostgreSQL 18.6, healthcheck, три именованные учебные базы |
| `migrate` | Одноразовая миграция application DB после готовности `db` |
| `backend` | Стартует после здоровой `db` и успешного `migrate` |
| `tools` | Явные одноразовые команды; профиль `tools` |
| `tests` | Полный набор тестов в tools image; отдельный доступ к source owner только для собственных test fixtures |
| `importer` | Необязательный повторный импорт; профиль `importer` |

Инициализация нового PostgreSQL volume создаёт роли, пустые базы `delivery_backoffice`, `delivery_backoffice_test`, `odoo_mock` и права source reader. Она **не** заполняет fake Odoo и не запускает application seed. `odoo_reader` остаётся отдельным пользователем с SELECT и read-only транзакциями. Автоматического seed/import при обычном старте нет.

## Первое копирование существующего стенда

Для существующих данных используется перенос из согласованной резервной копии, а не fresh seed.

1. Остановить нативный backend, importer, demo-сценарии и других писателей. Нативную PostgreSQL оставить работающей на время backup. Не запускать Docker backend или миграцию до восстановления пустой цели.
2. Подготовить секреты и проверить Compose:

```powershell
./scripts/docker-configure.ps1
docker compose config --quiet
```

3. Выполнить перенос только после фактической остановки писателей:

```powershell
./scripts/docker-transfer.ps1 -WritersStopped
```

`-WritersStopped` подтверждает выполненное действие оператора; сам по себе флаг не доказывает отсутствие писателей. Скрипт предназначен для backup → восстановления **только в пустые Docker-базы**, копирования test DB, приватных файлов и необходимых локальных account manifests. При непустой цели нужно остановиться и проверить её состояние; удаление или сброс данных не является продолжением этого runbook.

До переключения нужны завершённые проверки: все таблицы и точные digest их строк, версии/связи/история, application/source/test DB и SHA256/размеры файлов. Совпадение одних row counts не подтверждает сохранность содержимого. Pending/failed файлы не должны становиться ready. Существующие accounts, profiles, rosters, visits и signed results должны сохраниться.

**Перенос выполнен и проверен 2026-11-04.** Backup: `.local/backups/20261104T114759Z_373d1214`. Перед переключением точные row digests и последовательности всех трёх Docker DB совпали с нативными; повторная проверка подтвердила, что нативные данные не изменились. Четыре файла общим размером 379072 байта и два credential manifests совпали по hash. Проверены read-only ACL десяти source tables. На существующих данных seed не запускался.

Независимая проверка сохранена в [independent-docker-verification.json](../.local/backups/20261104T114759Z_373d1214/independent-docker-verification.json). Backup и нативный кластер сохранены. Этот уже завершённый перенос не повторяют поверх заполненных volumes. При ошибке отдельного будущего переноса нужно остановиться и проверить состояние, а не выполнять seed для «исправления» существующих данных. Процедура согласованного backup описана в [recovery.md](recovery.md).

4. После успешного сравнения остановить нативную PostgreSQL, сохранив её каталог. Нативный API должен оставаться остановленным: порт 3001 будет обслуживать Docker backend.
5. Запустить Docker backend обычной командой ниже. Для перенесённой application DB повторный seed не нужен. Обычный старт применяет только ещё не выполненные миграции.

После переключения нативная база — сохранённая копия, а не синхронная реплика Docker. Новые изменения Docker автоматически обратно не переносятся.

## Обычный запуск, состояние и остановка

Для уже восстановленных или ранее подготовленных volumes:

Текущий стенд включает также watch importer. Все его backend-сервисы поднимаются командой `docker compose --profile importer up -d --build`. Команда без профиля ниже поднимает основные API/database/migration services; importer можно включить отдельно в соответствующем разделе.

```powershell
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 db migrate backend
Invoke-RestMethod http://127.0.0.1:3001/api/health
```

Для `migrate` ожидается нормальное завершение с exit code 0. Ошибка миграции блокирует backend. API health проверяет подключение к application DB; отдельно проверяются fake Odoo import, login и приватные файлы. Не считать один HTTP 200 доказательством полного переноса.

После этого открыть frontend на `http://127.0.0.1:3000`. Для перенесённых данных используются сохранённые локальные demo accounts; пароли не меняются из-за смены способа запуска backend.

Остановить все сервисы этого проекта, включая активный importer:

```powershell
docker compose --profile "*" stop
```

Удалить только контейнеры и сеть, сохранив named volumes:

```powershell
docker compose --profile "*" down
```

Не добавлять `--volumes`/`-v` и не выполнять volume prune: это удалит сохранённые PostgreSQL и приватные файлы. Для обычной остановки такие действия не нужны.

## Пересборка после изменения backend

```powershell
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 migrate backend
```

Named volumes и секреты сохраняются. Если был включён importer и изменился его код, пересобрать и пересоздать его отдельно:

```powershell
docker compose --profile importer up -d --build importer
```

## Tools, проверки и ручной импорт

Одноразовые контейнеры удаляются через `--rm`; named volumes при этом сохраняются. Команды ниже исполняются с настоящими Docker PostgreSQL, auth/guards и общими доменными правилами:

```powershell
docker compose --profile tools run --rm tools npm run typecheck
docker compose --profile tools run --rm tools npm run lint
docker compose run --rm tests
```

Test DB должна быть подготовлена переносом или fresh-процедурой ниже. Тесты используют отдельную `delivery_backoffice_test` и собственные fixtures; production/application DB для этого не сбрасывается. Только сервис `tests` получает дополнительный source-owner secret для создания и удаления собственных изолированных source-схем. Backend, importer и обычный `tools` не получают эти права; application import использует `odoo_reader`.

Явная миграция test DB при необходимости:

```powershell
docker compose --profile tools run --rm tools npm run migrate -- --test
```

Ручной импорт читает fake Odoo и обновляет application DB с обычной авторизацией:

```powershell
docker compose --profile tools run --rm tools npm run import
```

Необязательный watch importer запускается явно:

```powershell
docker compose --profile importer up -d importer
docker compose --profile importer logs --tail=100 importer
```

Остановить только его:

```powershell
docker compose --profile importer stop importer
```

## Отдельный fresh-стенд

Полный end-to-end запуск этого fresh-сценария не выполнялся; подтверждённый перенос существующего стенда не заменяет такую проверку.

Этот раздел создаёт новые синтетические данные. Он не применяется к volumes с перенесёнными или пользовательскими записями. Для пробного fresh-запуска выбрать **новое, ещё не использованное имя проекта**; здесь пример `delivery-backoffice-fresh`. Это создаст отдельные named volumes. Повторное использование уже существующего имени не означает пустую базу.

Публикуемые порты совпадают с обычным стендом, поэтому сначала остановить его, сохранив данные:

```powershell
docker compose --profile "*" stop
./scripts/docker-configure.ps1
docker compose -p delivery-backoffice-fresh up -d db
docker compose -p delivery-backoffice-fresh ps
```

После healthy `db` явно подготовить только fresh источник и application/test DB. Source script требует Bash:

```powershell
docker compose -p delivery-backoffice-fresh exec -T db bash /opt/backoffice/docker/source-setup.sh
docker compose -p delivery-backoffice-fresh --profile tools build tools
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run migrate
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run migrate -- --test
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run seed
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run seed -- --test
docker compose -p delivery-backoffice-fresh --profile tools run --rm tools npm run import
docker compose -p delivery-backoffice-fresh up -d --build backend
```

Остановиться при первой неуспешной команде. `seed` создаёт локальные synthetic accounts в свежем `app-data`; он не должен подменять accounts существующего стенда. При необходимости сохранить их в отдельный игнорируемый локальный файл без печати содержимого:

```powershell
docker compose -p delivery-backoffice-fresh cp backend:/app/.local/demo-accounts.json .local/docker/fresh-demo-accounts.json
```

Тесты этого fresh-проекта:

```powershell
docker compose -p delivery-backoffice-fresh run --rm tests
```

Вернуться к сохранённому обычному проекту:

```powershell
docker compose -p delivery-backoffice-fresh --profile "*" stop
docker compose up -d
```

Fresh volumes остаются отдельными и сохраняются. Этот runbook не содержит их удаления и не перезаписывает нативный кластер.

## Подтверждённые результаты 2026-11-04

Окружение: Docker 29.9.2, Compose 5.6.1, Linux Node.js 26.13.0 и PostgreSQL 18.6.

| Проверка | Результат |
| --- | --- |
| Runtime/tools Docker build | PASS |
| Runtime user и private storage | UID 1000; запись в private files проверена |
| Linux sharp | PNG encode/decode PASS |
| Production `npm ci` audit | 0 vulnerabilities |
| Перенос трёх DB в пустую цель | Exact row digests и sequences совпали; native data unchanged |
| Файлы и credentials | SHA256/hash совпали: 4 файла, 379072 байта, 2 credential manifests |
| Source ACL | 10 таблиц доступны `odoo_reader` только для чтения |
| Docker typecheck и typed lint | PASS |
| Docker tests | 95/95 PASS after participant-skills implementation; initial Docker transfer phase was 87/87 |
| Host frontend → Docker API, read-only client smoke | 1/1 PASS |
| Текущее состояние Compose | `backend` и `db` healthy; `migrate` exit 0, `Applied migrations: []` |
| Необязательный importer | Профиль `importer` запущен; первый цикл succeeded, 20 pickings; интервал 60 секунд |
| Нативный стенд | API и PostgreSQL остановлены, исходный кластер сохранён |

Независимый отчёт также сравнил columns, indexes, owners, FK/PK, UNIQUE/EXCLUDE constraints, ACL и roles. Единственное текстовое отличие — расстановка скобок при ассоциативном AND в `person_check1`: выражения эквивалентны, но не идентичны побайтно. Это отличие явно сохранено в отчёте; утверждения о побайтном совпадении всего schema SQL нет.

Полная tools-установка с dev dependencies сообщила 10 moderate vulnerabilities в текущем lockfile. Обновления зависимостей в этой задаче не выполнялись. Этот результат учитывается отдельно от audit production-установки, где зарегистрировано 0 vulnerabilities.

Frontend-код не менялся; глобальные frontend typecheck/lint/tests/build повторно не запускались. Проверен существующий frontend с Docker API: read-only smoke 1/1 PASS, с прежним предупреждением tsx `DEP0205`. В браузере после reload Source sync показал успешный импорт 20 pickings от 04 Nov, 12:57; Refresh history сохранил тот же UI. Console: `[]`. [Скриншот Source sync](../../backoffice-frontend/docs/screenshots/backend-docker-source-sync-2026-11-04.jpg).

Полный fresh end-to-end сценарий остаётся непроверенным. Остальные отметки PASS выше относятся к перенесённому существующему стенду и указанной области проверки.

При проверках сохранять только несекретные отчёты, counts/digests и результаты команд. Не публиковать secret files, cookies, пароли, содержимое private files или полные connection URLs.

## Проверенные источники

- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/): раздельные build/runtime targets.
- [Node official images](https://hub.docker.com/_/node): Node 26.13.0 Debian slim variants.
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/): lockfile-based install и `--omit=dev`.
- [sharp installation](https://sharp.pixelplumbing.com/install/): платформенные Linux/glibc binaries и cross-platform lockfile considerations.
- [PostgreSQL official image](https://github.com/docker-library/docs/blob/master/postgres/README.md): PG18 volume layout и init scripts только для пустого data directory.
- [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/): healthy dependency и successful migration job.
- [Compose profiles](https://docs.docker.com/compose/how-tos/profiles/) и [project names](https://docs.docker.com/compose/how-tos/project-name/): tools/importer и отдельный fresh project.
