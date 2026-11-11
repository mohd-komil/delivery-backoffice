# Delivery Backoffice — локальный стенд

Самостоятельные соседние проекты без общего обязательного package workspace:

- [Backend: запуск, проверки, права, правила](backoffice-backend/README.md)
- [Frontend: запуск и интерфейс](backoffice-frontend/README.md)
- [Crew frontend: мобильный PWA, запуск и вход](crew-frontend/README.md)
- [План Notion v0.2](https://app.notion.com/p/40c4433fac0f815ab7e5fb9257f22047)
- [Подтверждённое состояние реализации](backoffice-backend/docs/STATUS.md)
- [Источник и ожидаемые SQL-результаты](backoffice-backend/docs/source-model.md)
- [Машины и транспорт визита](backoffice-backend/docs/vehicles.md)
- [Резервное копирование и восстановление](backoffice-backend/docs/recovery.md)

Основной backend-стенд запускается через Docker Compose: [инструкция Docker](backoffice-backend/docs/docker.md). PostgreSQL, backend, миграции и команды импорта/тестирования работают в контейнерах, данные и приватные файлы — в named volumes. Существующие данные перенесены; seed повторно не нужен. Нативный кластер сохранён отдельно для возврата. Frontend запускается из своего каталога на хосте. Интерфейс: http://127.0.0.1:3000, API: http://127.0.0.1:3001/api; PostgreSQL в Docker для SQL-клиентов: `127.0.0.1:55433`.

Пароли сгенерированы локально в игнорируемых `backoffice-backend/.local/demo-accounts.json` и `backoffice-backend/.local/participant-demo-accounts.json`. Не публикуйте `.env` и `.local`. Fake Odoo содержит только синтетические данные; совместимость с базой клиента не проверялась. Первый этап crew frontend работает локально на [127.0.0.1:3002](http://127.0.0.1:3002); production deployment вне текущего этапа.

